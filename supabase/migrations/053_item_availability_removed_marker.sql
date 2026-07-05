-- =============================================================================
-- MediStock Phoenix V2 — Migration 053: item_availability Removed Marker
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 052 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–052 must already be applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PROBLEM (found by REMOVED-OUTLET-MATERIAL-VISIBILITY-AUDIT-A)
-- ─────────────────────────────────────────────────────────────────────────────
--   Removing a material from an outlet (single-item "remove from outlet" in
--   InstitutionScreen.tsx, or the bulk clear_port_availability RPC / 042)
--   currently only sets quantity = 0 and condition = 'missing'. A genuinely
--   out-of-stock item (a real shortage that operations/alerts need to see and
--   act on) is stored identically. Every live-read surface — dashboard
--   counts, the live inter-institution alert-matching RPC, the low-stock
--   report, and (until migration 052) the public QR page — therefore cannot
--   tell "this outlet intentionally stopped carrying this material" apart
--   from "this outlet is out of stock and needs a resupply."
--
--   The only existing proxy is item_availability_movements.reason =
--   'removed_from_outlet', written by the single-item remove flow. It is not
--   a reliable general marker:
--     • clear_port_availability (042) writes NO per-row movement at all —
--       bulk-cleared rows have zero distinguishing signal today.
--     • Even for the single-item path, "the latest movement's reason" is
--       fragile (any later quantity movement on the same row overwrites it)
--       and no live-read surface is built to join against the movements
--       ledger per row.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- GOAL
-- ─────────────────────────────────────────────────────────────────────────────
--   Add an explicit, first-class removal marker directly on item_availability
--   so future removal operations can be reliably distinguished from genuine
--   shortage, while fully preserving movement history (item_availability is
--   still never hard-deleted; item_availability_movements/inter_org_alert_states/
--   inter_org_exchange_requests FKs remain valid).
--
--   This is a DB-ONLY migration. No frontend/service code is changed in this
--   phase — see "WHAT IS NOT CHANGED" below. The new removed_at/removed_by/
--   removal_reason columns and the two RPC filters (get_public_qr_payload,
--   phoenix_get_live_inter_institution_alerts_with_state) only ever affect
--   ROWS THAT A LATER REMOVAL OPERATION MARKS AFTER THIS MIGRATION IS APPLIED
--   — no existing row is touched by this migration, so nothing changes for
--   any already-live QR page or alert list until the next remove/clear action
--   happens through the updated RPCs below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEMA CHANGE
-- ─────────────────────────────────────────────────────────────────────────────
--   Add three nullable columns to public.item_availability:
--     • removed_at      timestamptz NULL — when the row was marked removed.
--     • removed_by      uuid NULL — who removed it. References auth.users(id)
--       via an explicitly named, idempotent FK constraint
--       (item_availability_removed_by_fkey, added in its own DO block —
--       FIX-MIGRATION-053-REMOVED-BY-FK-A — rather than an inline REFERENCES
--       clause), matching item_availability's OWN existing actor-tracking
--       column (last_updated_by, migration 001) exactly — NOT profiles(id).
--       This repo uses both patterns elsewhere (organizations/qr_tokens/
--       profiles' disabled_by use profiles(id); item_availability.
--       last_updated_by uses auth.users(id)) — for a sibling column on the
--       SAME table, consistency with the table's own existing pattern takes
--       precedence.
--     • removal_reason  text NULL — free-text label, e.g. 'removed_from_outlet'
--       or 'clear_port_availability' (mirrors item_availability_movements.reason,
--       which is also a free-text nullable column with no CHECK constraint —
--       migration 033).
--
--   NO BACKFILL: existing quantity=0/condition='missing' rows are NOT marked
--   removed by this migration. They may be genuine, still-open shortages —
--   marking them removed here would hide real shortage data from the alert
--   system and dashboards, which is exactly the bug this migration exists to
--   avoid introducing. Only removal operations performed AFTER this migration
--   is applied (via the updated RPCs below) ever set removed_at.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTIONS UPDATED (CREATE OR REPLACE FUNCTION, identical signatures)
-- ─────────────────────────────────────────────────────────────────────────────
--   A) phoenix_apply_availability_movement(uuid, text, integer, text, text)
--      — when p_reason = 'removed_from_outlet', the same UPDATE that already
--      writes the moved quantity now ALSO forces quantity = 0, condition =
--      'missing', removed_at = now(), removed_by = auth.uid(),
--      removal_reason = 'removed_from_outlet' on that row. Any other reason
--      leaves removed_at/removed_by/removal_reason untouched. The movement
--      row inserted into item_availability_movements is unchanged (still
--      records the actual computed quantity_before/delta/after) — only the
--      item_availability row's own outcome is guaranteed to land on exactly
--      quantity=0/condition='missing'/removed when this specific reason is
--      used, matching the single-item "remove from outlet" flow's intent.
--
--   B) clear_port_availability(uuid, text)
--      — the existing bulk UPDATE (migration 042) now also sets removed_at =
--      now(), removed_by = auth.uid(), removal_reason =
--      'clear_port_availability' for every row it zeroes. The idempotency
--      guard (only touches rows not already at quantity=0/condition='missing')
--      is unchanged, so a repeat call still does not re-touch rows already at
--      the target state — consistent with "no backfill of existing rows."
--      Still never deletes a row; still writes the same audit_logs entry.
--
--   C) phoenix_upsert_availability(... same 12+1 params as migration 051 ...)
--      — INSERT path: removed_at/removed_by/removal_reason are left to their
--      column default (NULL) — a newly created row is never removed.
--      UPDATE path (051's identity-matched re-add/edit): removed_at/
--      removed_by/removal_reason are cleared back to NULL — reactivating the
--      row — whenever the existing stored quantity is > 0 OR the submitted
--      condition is one of available/surplus/near_expiry/low_stock. A row
--      left at quantity=0 with condition='missing' is NOT reactivated by this
--      path (that combination is exactly "still shows as missing," which may
--      be a genuine ongoing shortage, not a re-add) — its removed_at is left
--      exactly as it was.
--
--   D) get_public_qr_payload(text) — migration 052's quantity<=0 → 'missing'
--      effective_condition logic is fully preserved (defense-in-depth: even a
--      row whose condition/quantity haven't been re-derived yet still gets
--      the 052 treatment). ADDITIONALLY, both branches that read
--      item_availability directly (distribution_point, local_item) now
--      exclude removed_at IS NOT NULL rows entirely from the payload — a
--      removed row does not merely show as 'missing', it is absent from the
--      list. No change to QR token/target resolution, scan counting, org
--      resolution, or the warehouse branch (which has no per-item output to
--      filter).
--
--   E) phoenix_get_live_inter_institution_alerts_with_state(integer) —
--      migration 048's expiry-risk-tier fields, migration 047's contact-phone
--      fields, and the alert_key/lifecycle-state upsert behavior are fully
--      preserved. ADDITIONALLY, the candidates CTE now excludes removed_at IS
--      NOT NULL rows, so an intentionally-removed material can never become a
--      supply or demand alert candidate (it was never a real gap to fill or a
--      real surplus to offer).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS NOT CHANGED IN THIS PHASE
-- ─────────────────────────────────────────────────────────────────────────────
--   • No frontend/service (.ts/.tsx) file is touched by this migration. The
--     JS query layer (dashboard.service.ts, availability.service.ts,
--     PortAvailabilitySection in InstitutionScreen.tsx) does NOT yet add
--     `.is('removed_at', null)` filters — that is an explicit, separate,
--     later phase, so no frontend code ships referencing a column the
--     deployed database doesn't have yet.
--   • getAvailabilityByOrg (Status Center / Status Editor — operations
--     context) is not touched anywhere, by design: staff there need to see
--     removed rows to manage/reactivate them.
--   • item_availability_movements, audit_logs, inter_org_alert_states,
--     inter_org_exchange_requests: schema unchanged, no new columns, no new
--     policies, no data mutation.
--   • No table is dropped, truncated, or has rows hard-deleted.
--   • No RLS policy is added, dropped, or altered.
--   • Grants on every modified function are unchanged from their prior
--     migration (034/042/051/052/048 respectively).
--   • All changes are idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF
--     NOT EXISTS / CREATE OR REPLACE FUNCTION. Safe to re-run.
-- =============================================================================

begin;

-- =============================================================================
-- SCHEMA: add removed_at / removed_by / removal_reason to item_availability
-- =============================================================================

-- FIX-MIGRATION-053-REMOVED-BY-FK-A: removed_by is added WITHOUT an inline
-- REFERENCES clause here. An inline "ADD COLUMN IF NOT EXISTS col ...
-- REFERENCES ..." is syntactically valid and does create the FK, but it
-- gives the constraint an auto-generated name and no way to check for its
-- existence independent of the column — this migration's own VERIFY block
-- (see below) previously tried to detect that inline FK via
-- information_schema.constraint_column_usage joined on table_schema, which
-- is a self-defeating check for a cross-schema reference (constraint_column_
-- usage.table_schema reports the REFERENCED table's schema, i.e. 'auth', not
-- the constrained table's schema 'public' — the join's own WHERE clause could
-- never match, so the ASSERT failed even when the FK existed). Adding the
-- column bare here and creating a NAMED constraint explicitly below makes
-- both creation and verification independently idempotent and correct.
alter table public.item_availability
  add column if not exists removed_at      timestamptz null,
  add column if not exists removed_by      uuid        null,
  add column if not exists removal_reason  text        null;

-- FIX-MIGRATION-053-REMOVED-BY-FK-A: create the removed_by -> auth.users(id)
-- foreign key as an explicitly named, idempotent constraint. Checking
-- pg_constraint by conname (rather than relying on ADD COLUMN's inline
-- REFERENCES) means this block can be safely re-run: it only adds the
-- constraint if a constraint with this exact name doesn't already exist on
-- this table.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.item_availability'::regclass
      and contype = 'f'
      and conname = 'item_availability_removed_by_fkey'
  ) then
    alter table public.item_availability
      add constraint item_availability_removed_by_fkey
      foreign key (removed_by)
      references auth.users(id)
      on delete set null;
  end if;
end $$;

create index if not exists item_avail_removed_at_idx on public.item_availability(removed_at);

-- =============================================================================
-- A) phoenix_apply_availability_movement — mark removed on reason = 'removed_from_outlet'
-- =============================================================================
-- Body is otherwise byte-for-byte identical to migration 034's definition.
-- Only step 8's single UPDATE became a branch on p_reason.

CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement(
  p_item_availability_id uuid,
  p_movement_type        text,
  p_amount               integer,
  p_reason               text DEFAULT NULL,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor           uuid := auth.uid();
  v_role            text;
  v_my_org          uuid;
  v_is_super        boolean;
  v_row             public.item_availability%ROWTYPE;
  v_quantity_before integer;
  v_quantity_after  integer;
  v_quantity_delta  integer;
  v_movement_id     uuid;
  v_actor_name      text;
  v_actor_email     text;
  v_actor_role      text;
BEGIN
  -- 1. Auth required
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Basic input validation
  IF p_item_availability_id IS NULL THEN
    RAISE EXCEPTION 'item_availability_id_required' USING ERRCODE = '23514';
  END IF;

  IF p_movement_type IS NULL OR p_movement_type NOT IN ('set_exact', 'add', 'subtract', 'correction') THEN
    RAISE EXCEPTION 'invalid_movement_type' USING ERRCODE = '23514';
  END IF;

  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '23514';
  END IF;

  -- set_exact / correction: amount is the new absolute quantity -> >= 0
  IF p_movement_type IN ('set_exact', 'correction') AND p_amount < 0 THEN
    RAISE EXCEPTION 'amount_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  -- add / subtract: amount is a magnitude to apply -> > 0 (a zero-amount
  -- add/subtract would not be a real movement and should use set_exact/correction instead)
  IF p_movement_type IN ('add', 'subtract') AND p_amount <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive' USING ERRCODE = '23514';
  END IF;

  IF p_movement_type = 'correction' AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'correction_reason_required' USING ERRCODE = '23514';
  END IF;

  -- 3. Lock the target row before any authorization/math (prevents concurrent-movement races)
  SELECT * INTO v_row
  FROM public.item_availability
  WHERE id = p_item_availability_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'availability_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Authorize: org scope (organization_id is read from the LOCKED row,
  --    never trusted from client input) + permission per movement type.
  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  v_is_super := (v_role = 'super_admin');

  IF NOT v_is_super AND v_row.organization_id <> v_my_org THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super THEN
    IF p_movement_type = 'set_exact' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.set') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_set' USING ERRCODE = '42501';
    ELSIF p_movement_type = 'add' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.add') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_add' USING ERRCODE = '42501';
    ELSIF p_movement_type = 'subtract' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.subtract') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_subtract' USING ERRCODE = '42501';
    ELSIF p_movement_type = 'correction' AND NOT phoenix_profile_has_permission(v_actor, 'availability.quantity.correct') THEN
      RAISE EXCEPTION 'forbidden_availability_quantity_correct' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 5. Quantity math. item_availability.quantity is `integer not null default 0
  --    check (quantity >= 0)` (migration 001) — never null, so no COALESCE needed.
  v_quantity_before := v_row.quantity;

  CASE p_movement_type
    WHEN 'set_exact' THEN
      v_quantity_after := p_amount;
      v_quantity_delta := p_amount - v_quantity_before;
    WHEN 'add' THEN
      v_quantity_after := v_quantity_before + p_amount;
      v_quantity_delta := p_amount;
    WHEN 'subtract' THEN
      v_quantity_after := v_quantity_before - p_amount;
      v_quantity_delta := -p_amount;
    WHEN 'correction' THEN
      v_quantity_after := p_amount;
      v_quantity_delta := p_amount - v_quantity_before;
  END CASE;

  -- 6. Negative guard — raising here rolls back the whole transaction:
  --    no item_availability UPDATE and no item_availability_movements INSERT.
  IF v_quantity_after < 0 THEN
    RAISE EXCEPTION 'quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;

  -- 7. Resolve actor identity snapshot — item_availability_movements has no
  --    trigger of its own (migration 033), so this mirrors
  --    phoenix_populate_actor_snapshot()'s exact resolution logic (migration 014).
  SELECT p.full_name, u.email, p.role
    INTO v_actor_name, v_actor_email, v_actor_role
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_actor;

  -- 8. Atomic write: update the locked row (item_availability's own
  --    trg_actor_snapshot + set_updated_at triggers fire automatically and
  --    re-snapshot the current actor because last_updated_by is set here),
  --    then insert the immutable movement record.
  --
  --    QR-REMOVED-MARKER-053-A: when this movement's reason is
  --    'removed_from_outlet' (the exact reason the single-item "remove from
  --    outlet" flow always passes — InstitutionScreen.tsx), the row's own
  --    outcome is forced to quantity=0/condition='missing' and marked
  --    removed, regardless of the computed v_quantity_after (which should
  --    already be 0 in that flow, since it always subtracts/sets to zero
  --    first) — this is a defensive guarantee, not a behavior change for the
  --    existing caller. Any other reason leaves removed_at/removed_by/
  --    removal_reason untouched (NULL stays NULL; an existing removed row is
  --    reactivated only by phoenix_upsert_availability, never here).
  IF p_reason = 'removed_from_outlet' THEN
    UPDATE public.item_availability
       SET quantity        = 0,
           condition       = 'missing',
           removed_at      = now(),
           removed_by      = v_actor,
           removal_reason  = 'removed_from_outlet',
           last_updated_by = v_actor
     WHERE id = p_item_availability_id;
  ELSE
    UPDATE public.item_availability
       SET quantity        = v_quantity_after,
           last_updated_by = v_actor
     WHERE id = p_item_availability_id;
  END IF;

  INSERT INTO public.item_availability_movements (
    item_availability_id, organization_id, distribution_point_id,
    scientific_name, concentration, dosage_form, trade_name,
    movement_type, quantity_before, quantity_delta, quantity_after,
    reason, notes, created_by,
    actor_name_snapshot, actor_email_snapshot, actor_role_snapshot
  ) VALUES (
    v_row.id, v_row.organization_id, v_row.distribution_point_id,
    v_row.scientific_name, v_row.concentration, v_row.dosage_form, v_row.trade_name,
    p_movement_type, v_quantity_before, v_quantity_delta, v_quantity_after,
    p_reason, p_notes, v_actor,
    v_actor_name, v_actor_email, v_actor_role
  )
  RETURNING id INTO v_movement_id;

  RETURN jsonb_build_object(
    'ok', true,
    'item_availability_id', v_row.id,
    'movement_id', v_movement_id,
    'movement_type', p_movement_type,
    'quantity_before', v_quantity_before,
    'quantity_delta', v_quantity_delta,
    'quantity_after', v_quantity_after
  );
END;
$$;

-- Grants: unchanged from migration 034
REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) TO authenticated;

-- =============================================================================
-- B) clear_port_availability — mark removed on every row it zeroes
-- =============================================================================
-- Body is otherwise byte-for-byte identical to migration 042's definition.
-- Only the UPDATE's SET list gained the three new columns.

CREATE OR REPLACE FUNCTION public.clear_port_availability(
  p_point_id     uuid,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id     uuid;
  v_role         text;
  v_org_id       uuid;
  v_point_org    uuid;
  v_total_count  int;
  v_with_history int;
  v_required     text;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org_id
  FROM profiles WHERE id = v_actor_id;

  IF v_role NOT IN ('super_admin', 'hospital_admin', 'warehouse_manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  SELECT organization_id INTO v_point_org
  FROM distribution_points WHERE id = p_point_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'POINT_NOT_FOUND');
  END IF;

  IF v_role != 'super_admin' AND v_point_org != v_org_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  END IF;

  v_required := 'CLEAR_PORT_ITEMS_' || p_point_id::text;
  IF p_confirmation IS DISTINCT FROM v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CONFIRMATION_MISMATCH',
      'required', v_required
    );
  END IF;

  -- Counts are for the response/audit payload only — both groups below are
  -- handled identically (UPDATE, never DELETE). See the migration header for
  -- why "no movement history" does not imply "safe to hard-delete".
  SELECT count(*) INTO v_total_count
  FROM item_availability WHERE distribution_point_id = p_point_id;

  SELECT count(*) INTO v_with_history
  FROM item_availability ia
  WHERE ia.distribution_point_id = p_point_id
    AND EXISTS (
      SELECT 1 FROM item_availability_movements m
      WHERE m.item_availability_id = ia.id
    );

  -- QR-REMOVED-MARKER-053-A: every row this UPDATE actually touches (the
  -- idempotency guard below is unchanged from migration 042 — a row already
  -- at quantity=0/condition='missing' is left alone, so a repeat call never
  -- re-marks or re-timestamps an already-cleared row) is now also marked
  -- removed, giving bulk-cleared rows the same removal signal the single-item
  -- "remove from outlet" flow gets.
  UPDATE item_availability
     SET quantity        = 0,
         condition        = 'missing',
         removed_at       = now(),
         removed_by       = v_actor_id,
         removal_reason   = 'clear_port_availability',
         last_updated_by  = v_actor_id
   WHERE distribution_point_id = p_point_id
     AND (quantity <> 0 OR condition IS DISTINCT FROM 'missing');

  INSERT INTO audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, payload
  ) VALUES (
    v_point_org, v_actor_id, v_role, 'port_items_cleared',
    'distribution_point', p_point_id,
    jsonb_build_object(
      'items_cleared', v_total_count,
      'items_with_movement_history', v_with_history,
      'mode', 'zeroed_not_deleted'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cleared', v_total_count,
    'items_with_movement_history', v_with_history,
    'mode', 'zeroed_not_deleted'
  );
END;
$$;

-- Grants: unchanged from migration 042
REVOKE ALL ON FUNCTION public.clear_port_availability(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_port_availability(uuid, text) TO authenticated;

-- =============================================================================
-- C) phoenix_upsert_availability — reactivate (clear removed_at) on active re-add
-- =============================================================================
-- Body is otherwise byte-for-byte identical to migration 051's definition.
-- Only the UPDATE path's SET list gained the three reactivation columns; the
-- INSERT path is unchanged (removed_at/removed_by/removal_reason default to
-- NULL for a newly created row — no column needs to be listed for that).

CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability(
  p_distribution_point_id uuid,
  p_scientific_name        text,
  p_trade_name             text,
  p_dosage_form            text,
  p_concentration          text,
  p_quantity               integer,
  p_condition              text,
  p_expiry_date            date,
  p_batch_number           text,
  p_notes                  text,
  p_supply_type            text,
  p_price                  numeric,
  p_national_code          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role               text := phoenix_my_role();
  v_my_org             uuid := phoenix_my_org();
  v_point_org          uuid;
  v_port_name          text;
  v_dp                 public.distribution_points%ROWTYPE;
  v_dosage             text := COALESCE(p_dosage_form, '');
  v_conc               text := COALESCE(p_concentration, '');
  v_national_code      text := NULLIF(btrim(p_national_code), '');
  v_batch_number       text := NULLIF(btrim(p_batch_number), '');
  v_national_code_key  text := COALESCE(NULLIF(btrim(p_national_code), ''), '');
  v_batch_number_key   text := COALESCE(NULLIF(btrim(p_batch_number), ''), '');
  -- FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A: `date`, not `text` — must
  -- match the immutable index expression above exactly (a text/::text
  -- cast is not IMMUTABLE and is rejected by CREATE UNIQUE INDEX).
  v_expiry_date_key    date := COALESCE(p_expiry_date, DATE '0001-01-01');
  v_id                 uuid;
  v_is_super           boolean;
  v_in_scope           boolean;
  v_existing_id        uuid;
  v_existing_quantity  integer;
  -- QR-REMOVED-MARKER-053-A: whether the incoming upsert represents active
  -- stock. Only used on the UPDATE path — never marks a row removed by
  -- itself, only ever clears an existing removal marker.
  v_reactivates        boolean;
BEGIN
  -- 0. scientific_name is required for the new path
  IF p_scientific_name IS NULL OR btrim(p_scientific_name) = '' THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;

  -- 1. derive the owning org AND a display port_name from the point
  --    (trusted source, never trusted from the client).
  SELECT * INTO v_dp
  FROM public.distribution_points
  WHERE id = p_distribution_point_id;

  IF NOT FOUND OR v_dp.organization_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_point_org := v_dp.organization_id;

  -- 1b. Derive a guaranteed non-null port_name (JSONB fallback for schema drift)
  v_port_name := COALESCE(
    NULLIF(to_jsonb(v_dp)->>'name', ''),
    NULLIF(to_jsonb(v_dp)->>'name_ar', ''),
    NULLIF(to_jsonb(v_dp)->>'display_name', ''),
    NULLIF(to_jsonb(v_dp)->>'port_name', ''),
    NULLIF(to_jsonb(v_dp)->>'title', ''),
    p_distribution_point_id::text
  );

  -- 2. authorize: permission-matrix based (unchanged from migration 035/050)
  v_is_super := (v_role = 'super_admin');
  v_in_scope := v_is_super OR (v_point_org = v_my_org);

  IF NOT v_in_scope THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super
     AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create')
     AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.update') THEN
    RAISE EXCEPTION 'forbidden_role_or_permission' USING ERRCODE = '42501';
  END IF;

  -- 3. Determine whether a matching row already exists. Matching key is
  --    WIDENED here (DB-MATERIAL-BATCH-IDENTITY-051-A, Option A) to mirror
  --    the new partial unique index above: distribution_point_id +
  --    scientific_name + COALESCE(concentration,'') + COALESCE(dosage_form,'')
  --    + COALESCE(national_code,'') + COALESCE(batch_number,'') +
  --    COALESCE(expiry_date, DATE '0001-01-01'). supply_type and price are
  --    intentionally NOT part of this match — they remain UI-mediated
  --    metadata (AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-A's panel), not DB
  --    identity, per the Option A design decision. expiry_date is compared
  --    as `date` (not text) per FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A —
  --    must match the index expression exactly for the RPC's INSERT-on-
  --    no-match / UPDATE-on-match branching to agree with what the unique
  --    index will actually accept.
  SELECT ia.id, ia.quantity INTO v_existing_id, v_existing_quantity
  FROM public.item_availability AS ia
  WHERE ia.distribution_point_id = p_distribution_point_id
    AND ia.scientific_name       = p_scientific_name
    AND COALESCE(ia.concentration, '')                 = v_conc
    AND COALESCE(ia.dosage_form,  '')                   = v_dosage
    AND COALESCE(ia.national_code, '')                  = v_national_code_key
    AND COALESCE(ia.batch_number, '')                   = v_batch_number_key
    AND COALESCE(ia.expiry_date, DATE '0001-01-01')     = v_expiry_date_key;

  IF v_existing_id IS NOT NULL THEN
    -- 4. UPDATE path — requires availability.update (super_admin always allowed).
    IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.update') THEN
      RAISE EXCEPTION 'forbidden_availability_update' USING ERRCODE = '42501';
    END IF;

    -- 4b. BACKEND-QUANTITY-UPSERT-HARD-GUARD-A (migration 035), preserved
    --     verbatim: quantity can never be changed through this RPC's UPDATE
    --     path.
    IF p_quantity IS DISTINCT FROM v_existing_quantity THEN
      RAISE EXCEPTION 'quantity_update_requires_movement' USING ERRCODE = '23514';
    END IF;

    -- QR-REMOVED-MARKER-053-A: reactivate (clear removed_at/removed_by/
    -- removal_reason) only when this row represents active stock — positive
    -- existing quantity, OR a condition that is not itself a shortage state.
    -- A row still at quantity=0/condition='missing' is left exactly as it
    -- was (may be a genuine, still-open shortage, not a re-add) — its
    -- removed_at is NOT touched by this branch.
    v_reactivates := (v_existing_quantity > 0)
      OR (p_condition IN ('available', 'surplus', 'near_expiry', 'low_stock'));

    -- quantity is intentionally NOT in this SET list (migration 035 guard).
    -- national_code/batch_number/expiry_date are now assigned directly from
    -- their normalized submitted values (v_national_code, v_batch_number,
    -- p_expiry_date), NOT the old COALESCE-preserve trick migration 050 used
    -- for national_code — that trick existed only because national_code was
    -- NOT part of the match key yet. Now that all three are part of the
    -- WHERE clause above, reaching this branch already proves the submitted
    -- and stored values are equal (up to NULL/'' normalization), so a direct
    -- assignment cannot move this row's identity — it can only normalize
    -- incidental whitespace/blank-vs-NULL differences. See the migration
    -- header ("Identity-field UPDATE behavior") for the full reasoning.
    UPDATE public.item_availability AS ia
       SET condition     = p_condition,
           notes         = p_notes,
           supply_type   = p_supply_type,
           price         = p_price,
           trade_name    = p_trade_name,
           national_code = v_national_code,
           batch_number  = v_batch_number,
           expiry_date   = p_expiry_date,
           removed_at     = CASE WHEN v_reactivates THEN NULL ELSE ia.removed_at END,
           removed_by     = CASE WHEN v_reactivates THEN NULL ELSE ia.removed_by END,
           removal_reason = CASE WHEN v_reactivates THEN NULL ELSE ia.removal_reason END
     WHERE ia.id = v_existing_id
    RETURNING ia.id INTO v_id;

    RETURN v_id;
  END IF;

  -- 5. INSERT path — requires availability.create
  IF NOT v_is_super AND NOT phoenix_profile_has_permission(auth.uid(), 'availability.create') THEN
    RAISE EXCEPTION 'forbidden_availability_create' USING ERRCODE = '42501';
  END IF;

  -- 6. INSERT (super_admin, or any role holding availability.create).
  -- removed_at/removed_by/removal_reason are intentionally NOT listed here —
  -- they default to NULL (QR-REMOVED-MARKER-053-A): a brand-new row is never
  -- removed.
  INSERT INTO public.item_availability (
    distribution_point_id,
    organization_id,
    port_name,
    scientific_name,
    trade_name,
    dosage_form,
    concentration,
    quantity,
    condition,
    expiry_date,
    batch_number,
    notes,
    supply_type,
    price,
    national_code
  ) VALUES (
    p_distribution_point_id,
    v_point_org,
    v_port_name,
    p_scientific_name,
    p_trade_name,
    v_dosage,
    v_conc,
    p_quantity,
    p_condition,
    p_expiry_date,
    v_batch_number,
    p_notes,
    p_supply_type,
    p_price,
    v_national_code
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- =============================================================================
-- D) get_public_qr_payload — exclude removed_at IS NOT NULL rows from the payload
-- =============================================================================
-- Body is otherwise byte-for-byte identical to migration 052's definition.
-- Only the two derived subqueries' WHERE clauses gained one line each.

create or replace function get_public_qr_payload(p_public_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   qr_tokens%rowtype;
  v_target  qr_targets%rowtype;
  v_org     organizations%rowtype;
  v_payload jsonb;
begin
  -- resolve token (unchanged)
  select * into v_token
  from qr_tokens
  where public_id = p_public_id and status = 'active'
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'QR_NOT_FOUND_OR_DISABLED'
    );
  end if;

  -- resolve target (unchanged)
  select * into v_target from qr_targets where id = v_token.qr_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  -- resolve org (unchanged)
  select * into v_org from organizations where id = v_target.organization_id;

  -- record scan (unchanged)
  update qr_tokens
  set last_scanned_at = now(), scan_count = scan_count + 1
  where id = v_token.id;

  -- build payload based on target type
  case v_target.target_type

    when 'distribution_point' then
      -- D4 (preserved from migration 027): reject archived/inactive distribution points
      if not exists (
        select 1 from distribution_points
        where id = v_target.target_id and status = 'active'
      ) then
        return jsonb_build_object('ok', false, 'error', 'DISTRIBUTION_POINT_NOT_ACTIVE');
      end if;

      select jsonb_build_object(
        'ok',          true,
        'target_type', 'distribution_point',
        'org_name',    v_org.name,
        'org_name_ar', v_org.name_ar,
        'point_label', coalesce(v_target.label, dp.name),
        'items', (
          -- Items aggregation with D6 + D7 fixes applied via a derived subquery.
          -- The outer jsonb_build_object reads computed columns from the subquery
          -- so effective_condition and expiry_bucket are each evaluated once.
          select jsonb_agg(jsonb_build_object(
            -- D6: public-safe display name via COALESCE fallback chain
            'name',          derived.row_name,
            'name_ar',       derived.row_name_ar,
            'unit',          derived.row_unit,
            -- D7 (+ quantity-zero fix): computed condition (overrides manual
            -- ia.condition when expiry triggers, or quantity <= 0)
            'condition',     derived.effective_condition,
            -- D7: expiry bucket for 9/6/3/expired threshold badge on frontend
            'expiry_bucket', derived.expiry_bucket,
            -- D2 (preserved + extended to use effective_condition)
            'quantity',      case when derived.effective_condition = 'expired'
                               then null
                               else derived.ia_quantity
                             end,
            -- D3 (preserved + extended to use effective_condition)
            'expiry_date',   case when derived.effective_condition in ('near_expiry', 'expired')
                               then derived.ia_expiry_date
                               else null
                             end
          ) order by derived.row_name_ar)
          from (
            select
              -- D6: public-safe name fallback:
              --   1. central item English name  (when local_item_id IS NOT NULL)
              --   2. central item Arabic name   (cross-fallback for same item)
              --   3. ia.scientific_name         (when local_item_id IS NULL)
              --   4. safe English placeholder
              coalesce(ci.name,    ci.name_ar, ia.scientific_name, 'Unnamed material')   as row_name,
              coalesce(ci.name_ar, ci.name,    ia.scientific_name, 'مادة غير مسماة')   as row_name_ar,
              -- unit: from central_items when available; null for scientific_name-only rows
              ci.unit                                                                       as row_unit,
              ia.quantity                                                                   as ia_quantity,
              ia.expiry_date                                                                as ia_expiry_date,
              -- D7 (+ quantity-zero fix): effective_condition overrides
              -- ia.condition when expiry_date triggers a threshold, or when
              -- quantity has been zeroed out by a normal quantity movement
              -- without a matching condition change (QR-EFFECTIVE-CONDITION-
              -- QUANTITY-ZERO-052-A).
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                when ia.quantity <= 0
                  then 'missing'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then 'near_expiry'
                else ia.condition
              end as effective_condition,
              -- D7: expiry_bucket for fine-grained frontend threshold display
              -- (unchanged by this migration — purely expiry-driven)
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then '3_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then '6_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then '9_months'
                else null
              end as expiry_bucket
            from item_availability ia
            -- D6: LEFT JOIN so scientific_name-only rows (local_item_id = NULL) are included
            left join local_items li on li.id = ia.local_item_id
            left join central_items ci on ci.id = li.central_item_id
            where ia.distribution_point_id = v_target.target_id
              -- QR-REMOVED-MARKER-053-A: a removed row is absent from the
              -- payload entirely, not merely shown as 'missing'.
              and ia.removed_at is null
          ) derived
        )
      )
      into v_payload
      from distribution_points dp
      where dp.id = v_target.target_id;

    when 'warehouse' then
      -- warehouse branch: unchanged from migration 027/028 — this branch
      -- only returns point-level item_count, with no per-item condition
      -- field of any kind, so it needs no change in this migration.
      select jsonb_build_object(
        'ok',              true,
        'target_type',     'warehouse',
        'org_name',        v_org.name,
        'org_name_ar',     v_org.name_ar,
        'warehouse_label', coalesce(v_target.label, wh.name),
        'points', (
          select jsonb_agg(jsonb_build_object(
            'point_id',      dp.id,
            'point_name',    dp.name,
            'point_name_ar', dp.name_ar,
            'item_count', (
              select count(*) from item_availability
              where distribution_point_id = dp.id
            )
          ) order by dp.name_ar)
          from distribution_points dp
          where dp.warehouse_id = wh.id and dp.status = 'active'
        )
      )
      into v_payload
      from warehouses wh
      where wh.id = v_target.target_id;

    when 'local_item' then
      -- local_item branch: D7 fix applied; D6 does not apply here
      -- (this branch already filters by a specific local_item_id).
      select jsonb_build_object(
        'ok',           true,
        'target_type',  'local_item',
        'org_name',     v_org.name,
        'org_name_ar',  v_org.name_ar,
        'item_name',    ci.name,
        'item_name_ar', ci.name_ar,
        'unit',         ci.unit,
        'availability', (
          select jsonb_agg(jsonb_build_object(
            'point_name',    dp.name,
            'point_name_ar', dp.name_ar,
            -- D7 (+ quantity-zero fix): computed condition
            'condition',     derived.effective_condition,
            'expiry_bucket', derived.expiry_bucket,
            -- D2 (preserved + extended)
            'quantity',      case when derived.effective_condition = 'expired'
                               then null
                               else derived.ia_quantity
                             end,
            -- D3 (preserved + extended)
            'expiry_date',   case when derived.effective_condition in ('near_expiry', 'expired')
                               then derived.ia_expiry_date
                               else null
                             end
          ) order by dp.name_ar)
          from (
            select
              ia.quantity                                                          as ia_quantity,
              ia.expiry_date                                                       as ia_expiry_date,
              ia.distribution_point_id,
              -- D7 (+ quantity-zero fix): effective_condition
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                when ia.quantity <= 0
                  then 'missing'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then 'near_expiry'
                else ia.condition
              end as effective_condition,
              -- D7: expiry_bucket (unchanged by this migration)
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then '3_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then '6_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then '9_months'
                else null
              end as expiry_bucket
            from item_availability ia
            where ia.local_item_id = v_target.target_id
              -- QR-REMOVED-MARKER-053-A: a removed row is absent from the
              -- payload entirely, not merely shown as 'missing'.
              and ia.removed_at is null
          ) derived
          join distribution_points dp on dp.id = derived.distribution_point_id
        )
      )
      into v_payload
      from local_items li
      join central_items ci on ci.id = li.central_item_id
      where li.id = v_target.target_id;

    else
      return jsonb_build_object('ok', false, 'error', 'UNKNOWN_TARGET_TYPE');
  end case;

  return coalesce(v_payload, jsonb_build_object('ok', false, 'error', 'PAYLOAD_BUILD_FAILED'));
end;
$$;

-- Grants: unchanged from migration 003 / 027 / 028 / 052
revoke all on function get_public_qr_payload(text) from authenticated;
grant execute on function get_public_qr_payload(text) to anon, authenticated;

-- =============================================================================
-- E) phoenix_get_live_inter_institution_alerts_with_state — exclude removed rows
-- =============================================================================
-- Body is otherwise byte-for-byte identical to migration 048's definition.
-- Only the candidates CTE's WHERE clause gained one line.

CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_role       text;
  v_org        uuid;
  v_is_super   boolean;
  v_can_view   boolean;
  v_limit      integer;
  v_computed_at timestamptz := now();
  v_alerts     jsonb;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org
  FROM public.profiles WHERE id = v_actor;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  END IF;

  v_is_super := (v_role = 'super_admin');

  -- 2. Permission: super_admin bypass; otherwise require
  --    inter_institution_alerts.view (primary) or exchange_alerts.view
  --    (legacy, backward-compat only). No new permission key introduced.
  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')
    OR phoenix_profile_has_permission(v_actor, 'exchange_alerts.view');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- 3. Sanitize p_limit: default 200, capped to a safe maximum of 500,
  --    floored at 1 (never 0/negative). Identical to 036/037/039/047/048.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  -- 4. Compute alerts and compute a deterministic alert_key per row.
  WITH candidates AS (
    SELECT
      ia.id                     AS availability_id,
      ia.organization_id,
      ia.distribution_point_id,
      ia.scientific_name,
      ia.trade_name,
      ia.concentration,
      ia.dosage_form,
      ia.quantity,
      ia.expiry_date,
      lower(btrim(ia.scientific_name))                    AS norm_sci,
      lower(btrim(coalesce(ia.concentration, '')))         AS norm_conc,
      lower(btrim(coalesce(ia.dosage_form, '')))           AS norm_dosage,
      -- DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A: near-expiry participation window
      -- widened from 3 months (migrations 036-047) to 9 months. Priority
      -- order is UNCHANGED and still strictly: expired > missing >
      -- near_expiry > low_stock > surplus > available. effective_status
      -- itself remains one of exactly the same 6 values as before — the
      -- widened threshold only changes WHICH rows land in 'near_expiry',
      -- never adds a new effective_status value.
      CASE
        WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date THEN 'expired'
        WHEN ia.condition = 'expired' THEN 'expired'
        WHEN ia.quantity <= 0 THEN 'missing'
        WHEN ia.condition = 'missing' THEN 'missing'
        WHEN ia.expiry_date IS NOT NULL
          AND ia.expiry_date <= (current_date + interval '9 months')::date THEN 'near_expiry'
        WHEN ia.condition = 'near_expiry' THEN 'near_expiry'
        WHEN ia.condition = 'low_stock' THEN 'low_stock'
        WHEN ia.condition = 'surplus' THEN 'surplus'
        ELSE 'available'
      END AS effective_status
    FROM public.item_availability ia
    WHERE ia.scientific_name IS NOT NULL
      AND btrim(ia.scientific_name) <> ''
      -- QR-REMOVED-MARKER-053-A: an intentionally-removed material was never
      -- a real shortage to fill or a real surplus to offer — it must never
      -- become a supply/demand alert candidate.
      AND ia.removed_at IS NULL
  ),
  supply AS (
    SELECT * FROM candidates WHERE effective_status IN ('surplus', 'near_expiry')
  ),
  demand AS (
    SELECT * FROM candidates WHERE effective_status IN ('missing', 'low_stock')
  ),
  matched AS (
    SELECT
      s.availability_id       AS src_availability_id,
      d.availability_id       AS tgt_availability_id,
      s.organization_id       AS src_org,
      d.organization_id       AS tgt_org,
      s.distribution_point_id AS src_point,
      d.distribution_point_id AS tgt_point,
      s.scientific_name,
      s.concentration,
      s.dosage_form,
      s.trade_name            AS src_trade_name,
      d.trade_name             AS tgt_trade_name,
      s.effective_status      AS src_status,
      d.effective_status      AS tgt_status,
      s.quantity              AS src_qty,
      d.quantity               AS tgt_qty,
      s.expiry_date            AS src_expiry,
      CASE WHEN s.effective_status = 'near_expiry'
        THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage' END AS alert_type,
      CASE WHEN d.effective_status = 'missing'
        THEN 'high' ELSE 'medium' END AS severity,
      -- DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A: the two fields added in 048.
      CASE
        WHEN s.expiry_date IS NULL THEN 'unknown'
        WHEN s.expiry_date < current_date THEN 'expired'
        WHEN s.expiry_date <= (current_date + interval '3 months')::date THEN 'critical_3m'
        WHEN s.expiry_date <= (current_date + interval '6 months')::date THEN 'warning_6m'
        WHEN s.expiry_date <= (current_date + interval '9 months')::date THEN 'watch_9m'
        ELSE 'normal'
      END AS src_expiry_risk_tier,
      CASE
        WHEN s.expiry_date IS NULL THEN NULL
        ELSE (s.expiry_date - current_date)
      END AS src_expiry_days_remaining
    FROM supply s
    JOIN demand d
      ON s.organization_id <> d.organization_id
     AND s.norm_sci    = d.norm_sci
     AND s.norm_conc   = d.norm_conc
     AND s.norm_dosage = d.norm_dosage
  ),
  scoped AS (
    SELECT m.*, so.name AS src_org_name, so.name_ar AS src_org_name_ar,
           to_.name AS tgt_org_name, to_.name_ar AS tgt_org_name_ar,
           sdp.name AS src_point_name, sdp.name_ar AS src_point_name_ar,
           tdp.name AS tgt_point_name, tdp.name_ar AS tgt_point_name_ar,
           (m.src_availability_id::text || ':' || m.tgt_availability_id::text || ':' || m.alert_type) AS alert_key
    FROM matched m
    JOIN public.organizations so   ON so.id  = m.src_org
    JOIN public.organizations to_  ON to_.id = m.tgt_org
    LEFT JOIN public.distribution_points sdp ON sdp.id = m.src_point
    LEFT JOIN public.distribution_points tdp ON tdp.id = m.tgt_point
    WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org
    ORDER BY
      CASE m.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN m.alert_type = 'near_expiry_to_shortage' THEN m.src_expiry END ASC NULLS LAST,
      m.scientific_name ASC
    LIMIT v_limit
  ),
  -- 5. Upsert lifecycle state for every computed alert. A brand-new
  --    alert_key gets status='open'; an existing alert_key only has
  --    last_seen_at/severity_snapshot/identity-snapshot columns refreshed —
  --    status, reason, notes, and every acknowledged/in_progress/resolved/
  --    dismissed timestamp+by column are left completely untouched.
  --    IDENTICAL to migrations 039/047/048 — untouched by this migration.
  upserted AS (
    INSERT INTO public.inter_org_alert_states (
      alert_key, alert_type,
      source_item_availability_id, target_item_availability_id,
      source_organization_id, target_organization_id,
      scientific_name, concentration, dosage_form,
      status, severity_snapshot,
      first_seen_at, last_seen_at, created_at, updated_at
    )
    SELECT
      s.alert_key, s.alert_type,
      s.src_availability_id, s.tgt_availability_id,
      s.src_org, s.tgt_org,
      s.scientific_name, s.concentration, s.dosage_form,
      'open', s.severity,
      v_computed_at, v_computed_at, v_computed_at, v_computed_at
    FROM scoped s
    ON CONFLICT (alert_key) DO UPDATE SET
      last_seen_at      = v_computed_at,
      severity_snapshot = excluded.severity_snapshot,
      scientific_name   = excluded.scientific_name,
      concentration     = excluded.concentration,
      dosage_form       = excluded.dosage_form,
      updated_at        = v_computed_at
    RETURNING
      id, alert_key, status,
      first_seen_at, last_seen_at,
      acknowledged_at, acknowledged_by,
      in_progress_at, in_progress_by,
      resolved_at, resolved_by,
      dismissed_at, dismissed_by,
      reason, notes,
      (xmax = 0) AS was_inserted
  ),
  -- 6. Append an 'opened' system event ONLY for alert_keys that were newly
  --    inserted this call (was_inserted = true). IDENTICAL to migrations 039/047/048.
  events_inserted AS (
    INSERT INTO public.inter_org_alert_events (
      alert_state_id, event_type, actor_id,
      actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
      from_status, to_status, reason, notes
    )
    SELECT id, 'opened', NULL, NULL, NULL, NULL, NULL, 'open', NULL, NULL
    FROM upserted
    WHERE was_inserted
    RETURNING 1
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'alert_type',                      s.alert_type,
      'severity',                        s.severity,
      'source_item_availability_id',    s.src_availability_id,
      'target_item_availability_id',    s.tgt_availability_id,
      'source_organization_id',         s.src_org,
      'source_organization_name',       s.src_org_name,
      'source_organization_name_ar',    s.src_org_name_ar,
      'source_distribution_point_id',   s.src_point,
      'source_distribution_point_name', s.src_point_name,
      'source_distribution_point_name_ar', s.src_point_name_ar,
      'target_organization_id',         s.tgt_org,
      'target_organization_name',       s.tgt_org_name,
      'target_organization_name_ar',    s.tgt_org_name_ar,
      'target_distribution_point_id',   s.tgt_point,
      'target_distribution_point_name', s.tgt_point_name,
      'target_distribution_point_name_ar', s.tgt_point_name_ar,
      'scientific_name',                 s.scientific_name,
      'concentration',                   s.concentration,
      'dosage_form',                     s.dosage_form,
      'source_trade_name',               s.src_trade_name,
      'target_trade_name',               s.tgt_trade_name,
      'source_status',                   s.src_status,
      'target_status',                   s.tgt_status,
      'source_quantity',                 s.src_qty,
      'target_quantity',                 s.tgt_qty,
      'source_expiry_date',              s.src_expiry,
      -- DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A: preserved verbatim.
      'source_expiry_risk_tier',         s.src_expiry_risk_tier,
      'source_expiry_days_remaining',    s.src_expiry_days_remaining,
      -- DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A (migration 047): preserved verbatim.
      'source_contact_phone',            src_contact.phone,
      'target_contact_phone',            tgt_contact.phone,
      'computed_at',                      v_computed_at,
      'alert_key',                        u.alert_key,
      'lifecycle_status',                 u.status,
      'first_seen_at',                    u.first_seen_at,
      'last_seen_at',                      u.last_seen_at,
      'acknowledged_at',                   u.acknowledged_at,
      'acknowledged_by',                   u.acknowledged_by,
      'in_progress_at',                    u.in_progress_at,
      'in_progress_by',                    u.in_progress_by,
      'resolved_at',                       u.resolved_at,
      'resolved_by',                       u.resolved_by,
      'dismissed_at',                      u.dismissed_at,
      'dismissed_by',                      u.dismissed_by,
      'lifecycle_reason',                  u.reason,
      'lifecycle_notes',                   u.notes
    )
    ORDER BY
      CASE s.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN s.alert_type = 'near_expiry_to_shortage' THEN s.src_expiry END ASC NULLS LAST,
      s.scientific_name ASC
  )
  INTO v_alerts
  FROM scoped s
  JOIN upserted u ON u.alert_key = s.alert_key
  -- DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A (migration 047): preserved
  -- verbatim. Best active contact phone for this row's source/target
  -- organization.
  LEFT JOIN LATERAL (
    SELECT osc.phone
    FROM public.organization_status_contacts osc
    WHERE osc.organization_id = s.src_org
      AND osc.is_active = true
      AND osc.phone IS NOT NULL
    ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
    LIMIT 1
  ) src_contact ON true
  LEFT JOIN LATERAL (
    SELECT osc.phone
    FROM public.organization_status_contacts osc
    WHERE osc.organization_id = s.tgt_org
      AND osc.is_active = true
      AND osc.phone IS NOT NULL
    ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
    LIMIT 1
  ) tgt_contact ON true;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', coalesce(v_alerts, '[]'::jsonb),
    'computed_at', v_computed_at
  );
END;
$$;

-- Grants: unchanged from migration 048
REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)
  TO authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_col_exists   boolean;
  v_fn_def       text;
BEGIN
  -- V1: item_availability has the three new columns
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability'
      AND column_name = 'removed_at'
  ) INTO v_col_exists;
  ASSERT v_col_exists, 'VERIFY FAILED: item_availability.removed_at column missing';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability'
      AND column_name = 'removed_by'
  ) INTO v_col_exists;
  ASSERT v_col_exists, 'VERIFY FAILED: item_availability.removed_by column missing';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability'
      AND column_name = 'removal_reason'
  ) INTO v_col_exists;
  ASSERT v_col_exists, 'VERIFY FAILED: item_availability.removal_reason column missing';

  -- V2: removed_by has an FK to auth.users (matching last_updated_by's pattern).
  --
  -- FIX-MIGRATION-053-REMOVED-BY-FK-A: rewritten to use pg_constraint/
  -- pg_attribute directly instead of the information_schema view trio used
  -- previously. The prior check joined
  -- information_schema.table_constraints/key_column_usage/
  -- constraint_column_usage on "tc.table_schema = ccu.table_schema" — but
  -- constraint_column_usage.table_schema reports the schema of the
  -- REFERENCED table (here, 'auth'), not the constrained table ('public'),
  -- so that join condition can never be satisfied for a cross-schema FK and
  -- the ASSERT failed unconditionally, rolling back this entire migration
  -- even when the FK had been created successfully. This version compares
  -- conrelid/confrelid via regclass (schema-qualified, unambiguous) and
  -- resolves the constrained column name from conkey via pg_attribute —
  -- exactly the robust pattern this migration needs.
  ASSERT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN unnest(c.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.conrelid  = 'public.item_availability'::regclass
      AND c.contype   = 'f'
      AND c.confrelid = 'auth.users'::regclass
      AND a.attname   = 'removed_by'
  ), 'VERIFY FAILED: item_availability.removed_by is not FK''d to auth.users';

  -- V3: all five modified functions still exist
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'
  ), 'VERIFY FAILED: phoenix_apply_availability_movement missing';

  -- phoenix_apply_availability_movement checks
  SELECT pg_get_functiondef(oid) INTO v_fn_def
  FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement';

  ASSERT v_fn_def ILIKE '%removed_from_outlet%',
    'VERIFY FAILED: phoenix_apply_availability_movement does not reference removed_from_outlet';
  ASSERT v_fn_def ILIKE '%removed_at%' AND v_fn_def ILIKE '%removed_by%' AND v_fn_def ILIKE '%removal_reason%',
    'VERIFY FAILED: phoenix_apply_availability_movement does not set removed_at/removed_by/removal_reason';
  ASSERT v_fn_def NOT ILIKE '%DELETE FROM item_availability%',
    'VERIFY FAILED: phoenix_apply_availability_movement deletes from item_availability';
  ASSERT v_fn_def NOT ILIKE '%TRUNCATE%',
    'VERIFY FAILED: phoenix_apply_availability_movement contains TRUNCATE';

  -- clear_port_availability checks
  SELECT pg_get_functiondef(oid) INTO v_fn_def
  FROM pg_proc WHERE proname = 'clear_port_availability';

  ASSERT v_fn_def ILIKE '%removed_at%' AND v_fn_def ILIKE '%clear_port_availability%',
    'VERIFY FAILED: clear_port_availability does not mark removed rows with its own reason label';
  ASSERT v_fn_def NOT ILIKE '%DELETE FROM item_availability%',
    'VERIFY FAILED: clear_port_availability still deletes from item_availability';
  ASSERT v_fn_def NOT ILIKE '%TRUNCATE%',
    'VERIFY FAILED: clear_port_availability contains TRUNCATE';

  -- phoenix_upsert_availability checks
  SELECT pg_get_functiondef(oid) INTO v_fn_def
  FROM pg_proc WHERE proname = 'phoenix_upsert_availability';

  ASSERT v_fn_def ILIKE '%v_reactivates%' AND v_fn_def ILIKE '%removed_at%',
    'VERIFY FAILED: phoenix_upsert_availability does not clear removed_at on reactivation';
  ASSERT v_fn_def ILIKE '%scientific_name%' AND v_fn_def ILIKE '%national_code%' AND v_fn_def ILIKE '%batch_number%',
    'VERIFY FAILED: phoenix_upsert_availability lost 051 identity fields';

  -- get_public_qr_payload checks
  SELECT pg_get_functiondef(oid) INTO v_fn_def
  FROM pg_proc WHERE proname = 'get_public_qr_payload';

  ASSERT v_fn_def ILIKE '%ia.removed_at is null%' OR v_fn_def ~* 'ia\.removed_at\s+is\s+null',
    'VERIFY FAILED: get_public_qr_payload does not filter removed_at IS NULL';
  ASSERT v_fn_def ILIKE '%ia.quantity <= 0%',
    'VERIFY FAILED: get_public_qr_payload lost the 052 quantity<=0 -> missing branch';
  ASSERT v_fn_def NOT ILIKE '%''batch_number''%' AND v_fn_def NOT ILIKE '%''price''%',
    'VERIFY FAILED: get_public_qr_payload exposes a privacy-sensitive field';

  -- phoenix_get_live_inter_institution_alerts_with_state checks
  SELECT pg_get_functiondef(oid) INTO v_fn_def
  FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state';

  ASSERT v_fn_def ILIKE '%ia.removed_at is null%' OR v_fn_def ~* 'ia\.removed_at\s+is\s+null',
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts_with_state does not filter removed_at IS NULL';
  ASSERT v_fn_def ILIKE '%alert_key%',
    'VERIFY FAILED: alert_key logic missing from phoenix_get_live_inter_institution_alerts_with_state';
  ASSERT v_fn_def ILIKE '%source_contact_phone%' AND v_fn_def ILIKE '%target_contact_phone%',
    'VERIFY FAILED: contact phone fields missing from phoenix_get_live_inter_institution_alerts_with_state';
  ASSERT v_fn_def ILIKE '%source_expiry_risk_tier%',
    'VERIFY FAILED: expiry-risk-tier field missing from phoenix_get_live_inter_institution_alerts_with_state';

  -- Cross-function security guardrails
  FOR v_fn_def IN
    SELECT pg_get_functiondef(oid) FROM pg_proc
    WHERE proname IN (
      'phoenix_apply_availability_movement', 'clear_port_availability',
      'phoenix_upsert_availability', 'get_public_qr_payload',
      'phoenix_get_live_inter_institution_alerts_with_state'
    )
  LOOP
    ASSERT v_fn_def NOT ILIKE '%service_role%',
      'VERIFY FAILED: service_role reference found in a modified function';
    ASSERT v_fn_def NOT ILIKE '%auth.admin%',
      'VERIFY FAILED: auth.admin reference found in a modified function';
    ASSERT v_fn_def NOT ILIKE '%whatsapp%' AND v_fn_def NOT ILIKE '%graph.facebook%' AND v_fn_def NOT ILIKE '%bearer%',
      'VERIFY FAILED: WhatsApp/Graph API/Bearer token reference found in a modified function';
    ASSERT v_fn_def NOT ILIKE '%DROP TABLE%' AND v_fn_def NOT ILIKE '%TRUNCATE%',
      'VERIFY FAILED: DROP TABLE/TRUNCATE found in a modified function';
    ASSERT v_fn_def NOT ILIKE '%DELETE FROM item_availability %'
       AND v_fn_def NOT ILIKE '%delete from item_availability %',
      'VERIFY FAILED: DELETE FROM item_availability found in a modified function';
  END LOOP;

  -- V4: no RLS policy dropped/added by this migration
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability'
      AND policyname = 'avail_select_anon' AND qual <> 'false'
  ), 'VERIFY FAILED: avail_select_anon policy on item_availability changed from (false)';

  -- V5: grants remain safe (spot-check the two RPCs with anon-facing history)
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'get_public_qr_payload'
      AND grantee = 'anon' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: anon lost EXECUTE on get_public_qr_payload';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_get_live_inter_institution_alerts_with_state'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC gained EXECUTE on phoenix_get_live_inter_institution_alerts_with_state';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_apply_availability_movement'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC gained EXECUTE on phoenix_apply_availability_movement';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'clear_port_availability'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC gained EXECUTE on clear_port_availability';

  RAISE NOTICE 'Migration 053 verification passed: item_availability.removed_at/removed_by/removal_reason added (no backfill); phoenix_apply_availability_movement marks removed on reason=''removed_from_outlet''; clear_port_availability marks removed on every row it zeroes; phoenix_upsert_availability reactivates (clears removed_at) on active re-add; get_public_qr_payload and phoenix_get_live_inter_institution_alerts_with_state both exclude removed_at IS NOT NULL rows; all five function signatures, SECURITY DEFINER, SET search_path, and grants unchanged; no hard delete/TRUNCATE/RLS change introduced.';
END $$;

commit;

-- =============================================================================
-- POST-APPLY MANUAL VERIFICATION (run in Supabase SQL Editor)
-- =============================================================================
--
-- 1. Confirm the new columns exist and no existing row was auto-marked:
--    SELECT count(*) AS total,
--           count(*) FILTER (WHERE removed_at IS NOT NULL) AS removed
--    FROM item_availability;
--    -- Expected: removed = 0 immediately after applying this migration.
--
-- 2. Single-item remove smoke test: call phoenix_apply_availability_movement
--    with reason = 'removed_from_outlet' on a row with quantity > 0.
--    SELECT quantity, condition, removed_at, removed_by, removal_reason
--    FROM item_availability WHERE id = '<that row>';
--    -- Expected: quantity = 0, condition = 'missing', removed_at NOT NULL,
--    -- removal_reason = 'removed_from_outlet'.
--
-- 3. Bulk clear smoke test: call clear_port_availability on a port with items.
--    SELECT count(*) FILTER (WHERE removed_at IS NOT NULL)
--    FROM item_availability WHERE distribution_point_id = '<that point>';
--    -- Expected: equals the number of rows actually cleared.
--
-- 4. Reactivation smoke test: call phoenix_upsert_availability for the same
--    identity as a removed row, with a positive quantity movement afterward
--    or condition = 'available'/'surplus'/'near_expiry'/'low_stock'.
--    SELECT removed_at FROM item_availability WHERE id = '<that row>';
--    -- Expected: NULL after the upsert.
--
-- 5. QR smoke test: scan a QR whose point has a row just marked removed in
--    step 2. SELECT get_public_qr_payload('<public_id>');
--    -- Expected: that item is entirely absent from "items" (not merely
--    -- shown as 'missing').
--
-- 6. Alerts smoke test: call phoenix_get_live_inter_institution_alerts_with_state
--    and confirm no alert references the item_availability_id marked removed
--    in step 2.
--
-- =============================================================================
-- END OF MIGRATION 053
-- QR-REMOVED-MARKER-053-A / DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A
-- =============================================================================

-- ============================================================================
-- ALERT-CQRS-BOUNDARY-190 — G4.1 INTER-ORGANIZATION ALERT READ/WRITE SPLIT
--
-- Purely ADDITIVE. This migration drops nothing, revokes nothing, renames
-- nothing and edits no historical file. Every RPC that existed before it still
-- exists afterwards with the same signature, the same body and the same ACL.
--
-- WHY
--   public.phoenix_get_live_inter_institution_alerts_with_state is a HYBRID.
--   Reading it:
--     * computes the live cross-organization alert set, AND
--     * INSERTs/UPDATEs public.inter_org_alert_states for every computed alert,
--     * INSERTs an 'opened' row into public.inter_org_alert_events for each
--       newly-created state,
--     * and only then returns the read payload.
--   public.phoenix_get_live_inter_institution_alerts_with_state_page (148)
--   delegates to it at runtime, so the paged surface is a hybrid too.
--
--   Two ordinary UI reads therefore carry server-side write effects today: the
--   Internal Alerts screen (through the paged wrapper) and the Dashboard
--   summary widget (through the hybrid directly, at limit 200). Opening a
--   dashboard must not write lifecycle rows or emit lifecycle events.
--
-- WHAT THIS MIGRATION ADDS
--   1. ONE explicit COMMAND — phoenix_refresh_inter_org_alert_lifecycle —
--      whose declared purpose is to refresh/synchronize lifecycle state for the
--      currently live inter-organization alerts. It DELEGATES to the existing,
--      already-reviewed hybrid and discards the read payload, returning only
--      command metadata. It deliberately does NOT reimplement the upsert or the
--      'opened' event: one writer, reached explicitly instead of accidentally.
--   2. TWO PURE QUERIES — a paged projection and a dashboard summary — that
--      INSERT nothing, UPDATE nothing, DELETE nothing, emit no event, and never
--      call the hybrid or its paged wrapper.
--   3. ONE shared internal read projection both queries are built from, so the
--      two queries can never drift apart the way the two alert RPCs did before
--      Migration 189.
--
-- NO THIRD MATCHER (this is the load-bearing design decision)
--   The pure projection does NOT recompute which alerts exist. It calls
--   Migration 189's PURE base RPC — public.phoenix_get_live_inter_institution_
--   alerts(integer) — and enriches its rows. That RPC already owns, in ONE
--   place:
--     * the authentication gate and the permission gate,
--     * the organization scoping (super_admin, or actor org on either endpoint),
--     * the organization_kind/institution_class allowlist,
--     * the canonical Migration-150 material_identity_key match through 189's
--       shared scalar bridge,
--     * the distinct-organization invariant,
--     * the near-expiry participation window, the removed_at exclusion, the
--       severity rule, the ordering and the limit sanitisation.
--   None of that is restated here. There is no scientific_name match, no
--   trade_name match, no display-label fallback and no concentration-or-
--   dosage-form-alone match anywhere in this file. Canonical alert eligibility
--   and canonical material identity remain owned by 189 and 150.
--
--   Migration 189 converged the two alert RPCs on WHICH alerts exist while
--   deliberately leaving their PAYLOADS different: the base RPC carries neither
--   047's contact fields nor 048's expiry-risk fields, and composes no
--   alert_key. Every one of those is a pure function of what the base RPC
--   already returns plus one contact lookup, so the projection DERIVES them
--   rather than re-deriving the alert set:
--     * alert_key                    — 039's shape, verbatim:
--                                      src_availability:tgt_availability:type
--     * source_expiry_risk_tier      — 048's CASE over source_expiry_date
--     * source_expiry_days_remaining — 048's day difference
--     * source/target_contact_phone  — 047's active/is_primary-preferring
--                                      organization_status_contacts lookup
--     * the lifecycle block          — READ from inter_org_alert_states,
--                                      LEFT JOINed on alert_key. Never upserted.
--
-- A LIVE ALERT WITH NO PERSISTED STATE ROW READS AS 'open'
--   That is not a fabrication and not a default invented here: it is exactly
--   what the hybrid's own INSERT writes ('open', first_seen_at = last_seen_at =
--   computed_at) the first time it sees an alert. Projecting the same values
--   keeps the pure query answer-identical to today's hybrid answer whether or
--   not a refresh has run, which is what makes the Dashboard cutover a true
--   no-op for the numbers on screen.
--
-- SECURITY — NO WIDENING
--   * The shared projection is SECURITY DEFINER, and that is REQUIRED, not
--     stylistic, on two counts:
--       a. 047's contact resolution already bypasses organization_status_
--          contacts' RLS inside the hybrid's own SECURITY DEFINER body; an
--          INVOKER projection would silently drop contact phones the UI shows
--          today.
--       b. 038's inter_org_alert_states RLS policy requires
--          'inter_institution_alerts.view', while the alert RPCs also accept
--          the legacy 'exchange_alerts.view'. An INVOKER projection would show
--          a legacy-permission holder alerts with no lifecycle block — a
--          REGRESSION against the shipped hybrid. Matching the hybrid means
--          reading state under the same definer trust the hybrid already uses.
--     Visibility is NOT widened by this: every state row the projection reads
--     is keyed to an alert the base RPC already decided this actor may see.
--   * The projection is revoked from PUBLIC, anon AND authenticated. Its only
--     callers are the two SECURITY DEFINER query RPCs below.
--   * The two query RPCs are SECURITY DEFINER for one reason only: they must
--     reach that revoked projection. They add no gate of their own and no
--     scoping of their own — both come from the base RPC, verbatim, including
--     its NOT_AUTHENTICATED / ACTOR_PROFILE_NOT_FOUND / FORBIDDEN envelopes,
--     which are returned unchanged.
--   * The refresh COMMAND is SECURITY INVOKER: the hybrid it calls is already
--     granted to authenticated and is itself SECURITY DEFINER, so no elevation
--     is required and none is taken.
--   * anon and PUBLIC are revoked from all three new public RPCs. authenticated
--     is granted exactly the same population that can already reach the alert
--     surface. No table grant is added or changed: inter_org_alert_states keeps
--     038's SELECT-to-authenticated-under-RLS, and inter_org_alert_events keeps
--     having NO client grant at all. Access stays RPC-shaped.
--   * service_role is deliberately not decided here — 109's ALTER DEFAULT
--     PRIVILEGES already decides EXECUTE for it on every new public function,
--     and re-deciding it would fight 109 rather than harden 190.
--
-- BACKWARD COMPATIBILITY
--   The deployed Production application is currently behind master and may
--   still call the legacy surface. All six legacy RPCs
--   (…_alerts, …_with_state, …_with_state_page, …update_inter_org_alert_state,
--   …reopen_inter_org_alert, …get_inter_org_alert_events) are preserved
--   untouched and are re-asserted present and still granted in the verify block
--   below. Retirement is a separate, later decision that belongs after the
--   application cutover is proven in Production — not to this migration.
--
-- MANUAL APPLY ONLY. NEVER `supabase db push`.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PREFLIGHT — every structure this migration builds on must already exist.
-- ============================================================================
DO $preflight$
BEGIN
  -- 189's PURE base RPC is the single source of alert eligibility for the new
  -- queries. Without it there is nothing to project and nothing would stop a
  -- future edit from quietly reintroducing a second matcher.
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts(integer)') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: the PURE base alert RPC is absent';
  END IF;
  -- 189's shared canonical identity bridge. Asserted so this migration cannot
  -- be applied onto a pre-189 database whose base RPC still matched on display
  -- labels: the projection would then inherit label matching.
  IF to_regprocedure('public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: 189 canonical identity bridge is absent — the base RPC may still be label-matching';
  END IF;
  -- The hybrid the COMMAND delegates to.
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: the with_state hybrid is absent';
  END IF;
  -- The legacy paged wrapper. Not called by anything added here; asserted so
  -- the additive-only claim is checked against reality rather than assumed.
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: the legacy paged wrapper is absent';
  END IF;
  IF to_regclass('public.inter_org_alert_states') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: inter_org_alert_states (038) is absent';
  END IF;
  IF to_regclass('public.inter_org_alert_events') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: inter_org_alert_events (038) is absent';
  END IF;
  IF to_regclass('public.organization_status_contacts') IS NULL THEN
    RAISE EXCEPTION '190_precondition_failed: organization_status_contacts (008) is absent';
  END IF;
  -- alert_key is the join key of the whole read side. If it were not unique the
  -- LEFT JOIN below could multiply rows, silently inflating total_count and the
  -- dashboard counters.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.inter_org_alert_states'::regclass
      AND c.contype IN ('p','u')
      AND pg_get_constraintdef(c.oid) LIKE '%(alert_key)%'
  ) THEN
    RAISE EXCEPTION '190_precondition_failed: inter_org_alert_states.alert_key is not uniquely constrained — the lifecycle LEFT JOIN could multiply rows';
  END IF;
  -- Every lifecycle column the projection publishes, asserted by name so a
  -- future rename fails here instead of inside a function body.
  IF EXISTS (
    SELECT unnest(ARRAY[
      'alert_key','status','first_seen_at','last_seen_at',
      'acknowledged_at','acknowledged_by','in_progress_at','in_progress_by',
      'resolved_at','resolved_by','dismissed_at','dismissed_by','reason','notes'
    ]) AS col
    EXCEPT
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'inter_org_alert_states'
  ) THEN
    RAISE EXCEPTION '190_precondition_failed: inter_org_alert_states is missing a lifecycle column this projection publishes';
  END IF;
  -- The 047 contact columns the projection resolves.
  IF EXISTS (
    SELECT unnest(ARRAY['organization_id','phone','is_active','is_primary','created_at','updated_at']) AS col
    EXCEPT
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organization_status_contacts'
  ) THEN
    RAISE EXCEPTION '190_precondition_failed: organization_status_contacts is missing a column the 047 contact resolution uses';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. SHARED PURE READ PROJECTION (internal)
--
--    ONE object, called by BOTH new queries. Deliberately not two copies: two
--    copies of a read shape is precisely how the base and with_state RPCs
--    drifted three generations apart before 189.
--
--    PURE by construction. It contains no INSERT, no UPDATE, no DELETE and no
--    ON CONFLICT. The only RPC it calls is 189's base RPC, which is itself
--    pure. The hybrid and its paged wrapper are never named here.
--
--    It is VOLATILE (the plpgsql default) only because the base RPC it calls is
--    VOLATILE. Volatility is a planner marker, not a write claim; purity is
--    asserted structurally in the verify block below and behaviourally by the
--    dynamic suite.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._phoenix_live_inter_org_alert_read_projection_v1(
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $projection$
DECLARE
  v_base        jsonb;
  v_computed_at timestamptz;
  v_alerts      jsonb;
BEGIN
  -- The ONE canonical source of WHICH alerts exist, WHO may see them and in
  -- WHAT order. Its limit sanitisation (1..500) is inherited, not restated.
  v_base := public.phoenix_get_live_inter_institution_alerts(p_limit);

  -- NOT_AUTHENTICATED / ACTOR_PROFILE_NOT_FOUND / FORBIDDEN travel back to the
  -- caller verbatim, so the new surfaces cannot answer where the old one
  -- refused.
  IF NOT COALESCE((v_base->>'ok')::boolean, false) THEN
    RETURN v_base;
  END IF;

  v_computed_at := (v_base->>'computed_at')::timestamptz;

  SELECT COALESCE(jsonb_agg(x.enriched ORDER BY x.ord), '[]'::jsonb)
    INTO v_alerts
  FROM (
    SELECT
      t.ord,
      -- The base payload is carried through UNCHANGED and only extended. No
      -- field it produced is rewritten, renamed or dropped.
      t.elem || jsonb_build_object(
        'alert_key',                    k.alert_key,
        -- 048's expiry-risk tiers, recomputed from the source_expiry_date the
        -- base RPC already returned — not from a second read of the row.
        'source_expiry_risk_tier',
          CASE
            WHEN k.src_expiry IS NULL THEN 'unknown'
            WHEN k.src_expiry < current_date THEN 'expired'
            WHEN k.src_expiry <= (current_date + interval '3 months')::date THEN 'critical_3m'
            WHEN k.src_expiry <= (current_date + interval '6 months')::date THEN 'warning_6m'
            WHEN k.src_expiry <= (current_date + interval '9 months')::date THEN 'watch_9m'
            ELSE 'normal'
          END,
        'source_expiry_days_remaining',
          CASE WHEN k.src_expiry IS NULL THEN NULL ELSE (k.src_expiry - current_date) END,
        -- 047's contact resolution, character-for-character the hybrid's own
        -- ordering rule: active rows only, is_primary preferred, then freshest.
        'source_contact_phone',         src_contact.phone,
        'target_contact_phone',         tgt_contact.phone,
        -- The lifecycle block, READ ONLY. An alert with no persisted row yet
        -- reads exactly as the hybrid's INSERT would have written it.
        'lifecycle_status',             COALESCE(st.status, 'open'),
        'first_seen_at',                COALESCE(st.first_seen_at, v_computed_at),
        'last_seen_at',                 COALESCE(st.last_seen_at,  v_computed_at),
        'acknowledged_at',              st.acknowledged_at,
        'acknowledged_by',              st.acknowledged_by,
        'in_progress_at',               st.in_progress_at,
        'in_progress_by',               st.in_progress_by,
        'resolved_at',                  st.resolved_at,
        'resolved_by',                  st.resolved_by,
        'dismissed_at',                 st.dismissed_at,
        'dismissed_by',                 st.dismissed_by,
        'lifecycle_reason',             st.reason,
        'lifecycle_notes',              st.notes
      ) AS enriched
    FROM jsonb_array_elements(v_base->'alerts') WITH ORDINALITY AS t(elem, ord)
    -- Derived scalars, computed once per row and reused by every branch above.
    CROSS JOIN LATERAL (
      SELECT
        -- 039's alert_key shape, unchanged: two availability uuids and the
        -- alert type. Historical keys keep matching, so lifecycle rows written
        -- by the hybrid are found by the pure query and vice versa.
        (t.elem->>'source_item_availability_id') || ':' ||
        (t.elem->>'target_item_availability_id') || ':' ||
        (t.elem->>'alert_type')                        AS alert_key,
        (t.elem->>'source_expiry_date')::date          AS src_expiry,
        (t.elem->>'source_organization_id')::uuid      AS src_org,
        (t.elem->>'target_organization_id')::uuid      AS tgt_org
    ) k
    -- LEFT, never INNER: an alert that has never been persisted must still be
    -- returned. An INNER JOIN here would make the pure query silently answer
    -- with fewer alerts than the hybrid, which is the whole defect this
    -- migration exists to avoid reintroducing in a new costume.
    LEFT JOIN public.inter_org_alert_states st
      ON st.alert_key = k.alert_key
    LEFT JOIN LATERAL (
      SELECT osc.phone
      FROM public.organization_status_contacts osc
      WHERE osc.organization_id = k.src_org
        AND osc.is_active = true
        AND osc.phone IS NOT NULL
      ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
      LIMIT 1
    ) src_contact ON true
    LEFT JOIN LATERAL (
      SELECT osc.phone
      FROM public.organization_status_contacts osc
      WHERE osc.organization_id = k.tgt_org
        AND osc.is_active = true
        AND osc.phone IS NOT NULL
      ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
      LIMIT 1
    ) tgt_contact ON true
  ) x;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', v_alerts,
    -- Carried as jsonb, not re-serialised from text, so the value is
    -- byte-identical to what the base RPC produced.
    'computed_at', v_base->'computed_at'
  );
END;
$projection$;

COMMENT ON FUNCTION public._phoenix_live_inter_org_alert_read_projection_v1(integer) IS
  '190 internal PURE read projection for inter-organization alerts. Calls '
  'Migration 189 PURE base RPC for the alert set — never the with_state '
  'hybrid, never its paged wrapper — and enriches each row with the 039 '
  'alert_key, the 048 expiry-risk fields, the 047 contact phones and a '
  'READ-ONLY lifecycle block LEFT JOINed from inter_org_alert_states. Writes '
  'nothing: no INSERT, no UPDATE, no DELETE, no upsert, no lifecycle event. '
  'Holds NO material matching of its own — canonical identity stays owned by '
  '189/150 — and never falls back to scientific_name, trade_name, a display '
  'label, concentration alone or dosage form alone. SECURITY DEFINER so '
  'contact resolution and lifecycle reads match the hybrid exactly, including '
  'for holders of the legacy exchange_alerts.view permission. No client role '
  'may execute it; only the two 190 query RPCs call it.';

REVOKE ALL ON FUNCTION public._phoenix_live_inter_org_alert_read_projection_v1(integer)
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. THE COMMAND — explicit lifecycle refresh
--
--    The ONLY sanctioned way for an application to cause inter-organization
--    alert lifecycle writes from a screen load. It delegates to the existing,
--    already-reviewed hybrid rather than duplicating the upsert or the 'opened'
--    event, so there remains exactly ONE writer of inter_org_alert_states and
--    inter_org_alert_events on this path.
--
--    The read payload is discarded on purpose. A command that also returned the
--    rows would invite callers to keep reading through the writer, which is the
--    habit this migration is retiring.
--
--    p_limit defaults to 500 — the universe cap the paged read uses — so a
--    refresh covers exactly the alerts the page query will subsequently show.
--    The hybrid clamps it to 1..500 itself; that sanitisation is inherited,
--    not restated.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_refresh_inter_org_alert_lifecycle(
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $refresh$
DECLARE
  v_full jsonb;
BEGIN
  v_full := public.phoenix_get_live_inter_institution_alerts_with_state(p_limit);

  -- Refusals are returned verbatim: this command can never succeed where the
  -- hybrid refused, and never invents an error code of its own.
  IF NOT COALESCE((v_full->>'ok')::boolean, false) THEN
    RETURN v_full;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'refreshed_count', jsonb_array_length(COALESCE(v_full->'alerts', '[]'::jsonb)),
    'computed_at', v_full->'computed_at'
  );
END;
$refresh$;

COMMENT ON FUNCTION public.phoenix_refresh_inter_org_alert_lifecycle(integer) IS
  '190 COMMAND: refresh/synchronize lifecycle state for the currently live '
  'inter-organization alerts. Delegates to phoenix_get_live_inter_institution_'
  'alerts_with_state so the 039/047/048/053 upsert and its opened event remain '
  'the single writer, then discards the read payload and returns only '
  '{ok, refreshed_count, computed_at}. SECURITY INVOKER — the hybrid it calls '
  'is already granted to authenticated and applies its own gate, so no '
  'elevation is taken. Refusals from the hybrid are returned verbatim.';

REVOKE ALL ON FUNCTION public.phoenix_refresh_inter_org_alert_lifecycle(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_refresh_inter_org_alert_lifecycle(integer)
  TO authenticated;

-- ============================================================================
-- 3. THE PAGED QUERY — pure
--
--    Contract-compatible with 148's phoenix_get_live_inter_institution_alerts_
--    with_state_page: same limit/offset sanitisation, same 500-row universe,
--    the same 'executable' stamp on every element, and the same
--    {ok, alerts, total_count, limit, offset, computed_at} envelope.
--    The ONLY difference is that it writes nothing.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_query_live_inter_org_alerts_with_state_page(
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $page$
DECLARE
  v_full   jsonb;
  v_all    jsonb;
  v_total  integer;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_page   jsonb;
BEGIN
  -- 500 is this feed's universe cap by design (036/037/039/148 have always
  -- capped there), so total_count is a real total rather than a silent
  -- truncation — and pagination never needs a second copy of the matching
  -- logic.
  v_full := public._phoenix_live_inter_org_alert_read_projection_v1(500);
  IF NOT COALESCE((v_full->>'ok')::boolean, false) THEN
    RETURN v_full;
  END IF;
  v_all   := COALESCE(v_full->'alerts', '[]'::jsonb);
  v_total := jsonb_array_length(v_all);

  SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
    INTO v_page
  FROM (
    -- 148's stamp, preserved: every alert on this screen is permanently
    -- non-executable — peer-institution discovery has no execution corridor.
    SELECT (elem || jsonb_build_object('executable', false)) AS elem, ord
    FROM jsonb_array_elements(v_all) WITH ORDINALITY AS t(elem, ord)
    WHERE ord > v_offset AND ord <= v_offset + v_limit
  ) x;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', v_page,
    'total_count', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'computed_at', v_full->'computed_at'
  );
END;
$page$;

COMMENT ON FUNCTION public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer) IS
  '190 PURE QUERY: paged live inter-organization alerts merged with persisted '
  'lifecycle state. Payload-compatible with the 148 hybrid paged wrapper — '
  'same sanitisation, same 500-row universe, same executable stamp, same '
  '{ok, alerts, total_count, limit, offset, computed_at} envelope — but writes '
  'nothing and never calls the with_state hybrid or its paged wrapper. Reading '
  'it can never create or refresh a lifecycle row or emit a lifecycle event; '
  'that is phoenix_refresh_inter_org_alert_lifecycle job alone.';

REVOKE ALL ON FUNCTION public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)
  TO authenticated;

-- ============================================================================
-- 4. THE SUMMARY QUERY — pure
--
--    The Dashboard must stop fetching 200 alert objects to derive four numbers
--    client-side, and must stop causing lifecycle writes by rendering.
--
--    SEMANTIC PARITY IS THE REQUIREMENT, not a "better" number. The shipped
--    Dashboard calls the hybrid at limit 200 and then counts only alerts whose
--    lifecycle status is open/acknowledged/in_progress. Both halves are
--    preserved exactly:
--      * the 200-row window is the hybrid's own pre-existing limit, applied
--        BEFORE the status filter — it is inherited here, not introduced, and
--        p_limit is kept so the window stays visible and adjustable rather than
--        buried;
--      * resolved and dismissed alerts stay excluded from every counter.
--    Widening the window would silently change four numbers on a live screen,
--    which is not this slice's business.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_query_live_inter_org_alert_summary(
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $summary$
DECLARE
  v_full    jsonb;
  v_limit   integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_total   integer;
  v_high    integer;
  v_surplus integer;
  v_near    integer;
BEGIN
  -- The SAME pure projection the paged query is built from, so the summary can
  -- never describe a different alert set than the screen it links to.
  v_full := public._phoenix_live_inter_org_alert_read_projection_v1(v_limit);
  IF NOT COALESCE((v_full->>'ok')::boolean, false) THEN
    RETURN v_full;
  END IF;

  SELECT
    count(*)::int,
    count(*) FILTER (WHERE a.elem->>'severity' = 'high')::int,
    count(*) FILTER (WHERE a.elem->>'alert_type' = 'surplus_to_shortage')::int,
    count(*) FILTER (WHERE a.elem->>'alert_type' = 'near_expiry_to_shortage')::int
  INTO v_total, v_high, v_surplus, v_near
  FROM jsonb_array_elements(COALESCE(v_full->'alerts', '[]'::jsonb)) AS a(elem)
  -- Active lifecycle only — resolved/dismissed alerts are settled and are not
  -- part of the Dashboard's "needs attention" picture.
  WHERE a.elem->>'lifecycle_status' IN ('open', 'acknowledged', 'in_progress');

  RETURN jsonb_build_object(
    'ok', true,
    'total', COALESCE(v_total, 0),
    'high', COALESCE(v_high, 0),
    'surplus_to_shortage', COALESCE(v_surplus, 0),
    'near_expiry_to_shortage', COALESCE(v_near, 0),
    'computed_at', v_full->'computed_at'
  );
END;
$summary$;

COMMENT ON FUNCTION public.phoenix_query_live_inter_org_alert_summary(integer) IS
  '190 PURE QUERY: server-computed inter-organization alert summary for the '
  'Dashboard — {ok, total, high, surplus_to_shortage, near_expiry_to_shortage, '
  'computed_at}. Derived from the SAME pure projection as the paged query, so '
  'the two can never disagree. Counts only active lifecycle states '
  '(open/acknowledged/in_progress) within the pre-existing 200-row window, '
  'which is exact parity with the client-side derivation it replaces. Writes '
  'nothing; opening a dashboard causes zero inter-org alert writes.';

REVOKE ALL ON FUNCTION public.phoenix_query_live_inter_org_alert_summary(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_query_live_inter_org_alert_summary(integer)
  TO authenticated;

-- ============================================================================
-- VERIFY — the CQRS boundary must be real, not merely intended.
--
-- Structural purity is asserted over the ACTUAL catalog definitions, so a
-- future edit that reintroduces a write into either query aborts the
-- transaction that introduced it. The dynamic suite proves the same properties
-- behaviourally; these two are belt and braces, not substitutes.
-- ============================================================================
DO $verify$
DECLARE
  v_proj    text;
  v_page    text;
  v_summary text;
  v_refresh text;
  v_name    text;
  v_src     text;
  v_legacy  text;
BEGIN
  -- ------------------------------------------------------------------
  -- A. every new object exists at the exact signature the app will call
  -- ------------------------------------------------------------------
  IF to_regprocedure('public._phoenix_live_inter_org_alert_read_projection_v1(integer)') IS NULL THEN
    RAISE EXCEPTION '190 verify failed: the shared pure read projection was not created';
  END IF;
  IF to_regprocedure('public.phoenix_refresh_inter_org_alert_lifecycle(integer)') IS NULL THEN
    RAISE EXCEPTION '190 verify failed: the refresh COMMAND was not created';
  END IF;
  IF to_regprocedure('public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)') IS NULL THEN
    RAISE EXCEPTION '190 verify failed: the pure paged QUERY was not created';
  END IF;
  IF to_regprocedure('public.phoenix_query_live_inter_org_alert_summary(integer)') IS NULL THEN
    RAISE EXCEPTION '190 verify failed: the pure summary QUERY was not created';
  END IF;

  v_proj    := pg_get_functiondef('public._phoenix_live_inter_org_alert_read_projection_v1(integer)'::regprocedure);
  v_page    := pg_get_functiondef('public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)'::regprocedure);
  v_summary := pg_get_functiondef('public.phoenix_query_live_inter_org_alert_summary(integer)'::regprocedure);
  v_refresh := pg_get_functiondef('public.phoenix_refresh_inter_org_alert_lifecycle(integer)'::regprocedure);

  -- ------------------------------------------------------------------
  -- B. PURITY. Comment text is stripped before matching so a word like
  --    "INSERT" inside an explanatory comment can neither raise a false alarm
  --    nor be used to smuggle real DML past a naive substring check.
  -- ------------------------------------------------------------------
  FOREACH v_name IN ARRAY ARRAY[
    '_phoenix_live_inter_org_alert_read_projection_v1',
    'phoenix_query_live_inter_org_alerts_with_state_page',
    'phoenix_query_live_inter_org_alert_summary'
  ] LOOP
    v_src := CASE v_name
      WHEN '_phoenix_live_inter_org_alert_read_projection_v1'     THEN v_proj
      WHEN 'phoenix_query_live_inter_org_alerts_with_state_page'  THEN v_page
      ELSE v_summary
    END;
    -- strip line comments, then upper-case what is left for keyword matching
    v_src := upper(regexp_replace(v_src, E'--[^\n]*', ' ', 'g'));

    IF v_src ~ '\mINSERT\M' THEN
      RAISE EXCEPTION '190 verify failed: % contains an INSERT — the query side must be pure', v_name;
    END IF;
    IF v_src ~ '\mUPDATE\M' THEN
      RAISE EXCEPTION '190 verify failed: % contains an UPDATE — the query side must be pure', v_name;
    END IF;
    IF v_src ~ '\mDELETE\M' THEN
      RAISE EXCEPTION '190 verify failed: % contains a DELETE — the query side must be pure', v_name;
    END IF;
    IF v_src ~ 'ON\s+CONFLICT' THEN
      RAISE EXCEPTION '190 verify failed: % contains an upsert — the query side must be pure', v_name;
    END IF;
    IF v_src ~ '\mTRUNCATE\M' OR v_src ~ '\mMERGE\M' THEN
      RAISE EXCEPTION '190 verify failed: % contains a destructive statement', v_name;
    END IF;
    -- No query may reach the writer, directly or through its paged wrapper,
    -- and no query may call the COMMAND.
    IF v_src ~ 'PHOENIX_GET_LIVE_INTER_INSTITUTION_ALERTS_WITH_STATE' THEN
      RAISE EXCEPTION '190 verify failed: % delegates to the with_state hybrid (or its paged wrapper)', v_name;
    END IF;
    IF v_src ~ 'PHOENIX_REFRESH_INTER_ORG_ALERT_LIFECYCLE' THEN
      RAISE EXCEPTION '190 verify failed: % calls the refresh COMMAND', v_name;
    END IF;
    -- The events table has exactly one writer and it is not on this side.
    IF v_src ~ 'INTER_ORG_ALERT_EVENTS' THEN
      RAISE EXCEPTION '190 verify failed: % touches inter_org_alert_events', v_name;
    END IF;
  END LOOP;

  -- ------------------------------------------------------------------
  -- C. NO SECOND MATCHER. The queries must reach the alert set through 189's
  --    base RPC and must not restate identity on display labels.
  -- ------------------------------------------------------------------
  IF v_proj NOT LIKE '%phoenix_get_live_inter_institution_alerts(p_limit)%' THEN
    RAISE EXCEPTION '190 verify failed: the projection no longer delegates to the PURE base alert RPC';
  END IF;
  IF v_proj LIKE '%material_identity_key%'
     OR v_proj LIKE '%_phoenix_availability_material_identity_v1%'
     OR v_proj LIKE '%_phoenix_material_identity_v1%' THEN
    RAISE EXCEPTION '190 verify failed: the projection re-implements material identity instead of inheriting the 189 bridge';
  END IF;
  -- Anchored on FROM/JOIN: the projection legitimately CARRIES the base RPC's
  -- source_item_availability_id / target_item_availability_id field names, so a
  -- bare substring test would abort on its own payload. What must never appear
  -- is a direct READ of the table.
  IF v_proj ~* '(FROM|JOIN)[[:space:]]+(public\.)?item_availability\M' THEN
    RAISE EXCEPTION '190 verify failed: the projection reads item_availability directly — alert eligibility must stay owned by the base RPC';
  END IF;
  IF v_page NOT LIKE '%_phoenix_live_inter_org_alert_read_projection_v1(500)%' THEN
    RAISE EXCEPTION '190 verify failed: the paged query no longer reads through the shared projection';
  END IF;
  IF v_summary NOT LIKE '%_phoenix_live_inter_org_alert_read_projection_v1(v_limit)%' THEN
    RAISE EXCEPTION '190 verify failed: the summary query no longer reads through the shared projection';
  END IF;

  -- ------------------------------------------------------------------
  -- D. the COMMAND really is the writer path, and really does delegate
  -- ------------------------------------------------------------------
  IF v_refresh NOT LIKE '%phoenix_get_live_inter_institution_alerts_with_state(p_limit)%' THEN
    RAISE EXCEPTION '190 verify failed: the refresh COMMAND no longer delegates to the canonical hybrid';
  END IF;
  IF upper(regexp_replace(v_refresh, E'--[^\n]*', ' ', 'g')) ~ '\mINSERT\M' THEN
    RAISE EXCEPTION '190 verify failed: the refresh COMMAND duplicates the lifecycle upsert instead of delegating';
  END IF;

  -- ------------------------------------------------------------------
  -- E. security posture: pinned search_path, definer only where required
  -- ------------------------------------------------------------------
  IF v_proj NOT LIKE '%SET search_path%' OR v_page NOT LIKE '%SET search_path%'
     OR v_summary NOT LIKE '%SET search_path%' OR v_refresh NOT LIKE '%SET search_path%' THEN
    RAISE EXCEPTION '190 verify failed: a new function lost its explicit search_path';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public._phoenix_live_inter_org_alert_read_projection_v1(integer)'::regprocedure) THEN
    RAISE EXCEPTION '190 verify failed: the projection must be SECURITY DEFINER to match the hybrid contact and lifecycle reads';
  END IF;
  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.phoenix_refresh_inter_org_alert_lifecycle(integer)'::regprocedure) THEN
    RAISE EXCEPTION '190 verify failed: the refresh COMMAND took SECURITY DEFINER it does not need';
  END IF;

  -- ------------------------------------------------------------------
  -- F. ACLs: anon and PUBLIC denied everywhere; the projection reachable only
  --    through the two query RPCs.
  -- ------------------------------------------------------------------
  IF has_function_privilege('anon', 'public._phoenix_live_inter_org_alert_read_projection_v1(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._phoenix_live_inter_org_alert_read_projection_v1(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '190 verify failed: the internal projection is directly callable by a client role';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_refresh_inter_org_alert_lifecycle(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_query_live_inter_org_alert_summary(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '190 verify failed: anon can execute a new alert RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.phoenix_refresh_inter_org_alert_lifecycle(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.phoenix_query_live_inter_org_alert_summary(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '190 verify failed: authenticated cannot reach the new alert surface';
  END IF;

  -- ------------------------------------------------------------------
  -- G. NO TABLE-GRANT WIDENING. The queries must not have been "solved" by
  --    opening the lifecycle tables to clients.
  -- ------------------------------------------------------------------
  IF has_table_privilege('anon', 'public.inter_org_alert_states', 'SELECT')
     OR has_table_privilege('anon', 'public.inter_org_alert_events', 'SELECT') THEN
    RAISE EXCEPTION '190 verify failed: anon can read a lifecycle table';
  END IF;
  IF has_table_privilege('authenticated', 'public.inter_org_alert_events', 'SELECT') THEN
    RAISE EXCEPTION '190 verify failed: authenticated gained direct SELECT on inter_org_alert_events';
  END IF;
  IF has_table_privilege('authenticated', 'public.inter_org_alert_states', 'INSERT')
     OR has_table_privilege('authenticated', 'public.inter_org_alert_states', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.inter_org_alert_states', 'DELETE') THEN
    RAISE EXCEPTION '190 verify failed: authenticated gained a direct write on inter_org_alert_states';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'inter_org_alert_states'
                    AND policyname = 'inter_org_alert_states_select_perm') THEN
    RAISE EXCEPTION '190 verify failed: the 038 lifecycle read policy is missing';
  END IF;

  -- ------------------------------------------------------------------
  -- H. ADDITIVE ONLY. Every legacy RPC survives at its exact signature, still
  --    reachable by authenticated and still denied to anon. The deployed
  --    application is behind master and may still be calling all of these.
  -- ------------------------------------------------------------------
  FOREACH v_legacy IN ARRAY ARRAY[
    'public.phoenix_get_live_inter_institution_alerts(integer)',
    'public.phoenix_get_live_inter_institution_alerts_with_state(integer)',
    'public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)',
    'public.phoenix_update_inter_org_alert_state(text,text,text,text)',
    'public.phoenix_reopen_inter_org_alert(text,text,text)',
    'public.phoenix_get_inter_org_alert_events(text)'
  ] LOOP
    IF to_regprocedure(v_legacy) IS NULL THEN
      RAISE EXCEPTION '190 verify failed: legacy RPC % was removed — 190 must be additive', v_legacy;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_legacy), 'EXECUTE') THEN
      RAISE EXCEPTION '190 verify failed: legacy RPC % lost authenticated EXECUTE', v_legacy;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_legacy), 'EXECUTE') THEN
      RAISE EXCEPTION '190 verify failed: legacy RPC % became anon-reachable', v_legacy;
    END IF;
  END LOOP;

  -- The hybrid must still BE the hybrid: 190 does not quietly neuter the old
  -- write path while claiming to be additive.
  v_legacy := pg_get_functiondef('public.phoenix_get_live_inter_institution_alerts_with_state(integer)'::regprocedure);
  IF v_legacy NOT LIKE '%INSERT INTO public.inter_org_alert_states%'
     OR v_legacy NOT LIKE '%inter_org_alert_events%' THEN
    RAISE EXCEPTION '190 verify failed: the with_state hybrid was altered — 190 must leave it exactly as 189 left it';
  END IF;
  -- 189's canonical identity bridge is untouched and still the only matcher.
  IF to_regprocedure('public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '190 verify failed: the 189 canonical identity bridge disappeared';
  END IF;

  -- ------------------------------------------------------------------
  -- I. BEHAVIOURAL, DATA-INDEPENDENT. An unauthenticated caller must be refused
  --    by every new surface, and the refusal must be the base/hybrid envelope
  --    rather than an empty success. auth.uid() is NULL inside this migration,
  --    so this assertion is always armed, even on an empty database.
  -- ------------------------------------------------------------------
  IF (public.phoenix_query_live_inter_org_alerts_with_state_page(10, 0))->>'error' IS DISTINCT FROM 'NOT_AUTHENTICATED' THEN
    RAISE EXCEPTION '190 verify failed: the paged query does not refuse an unauthenticated caller';
  END IF;
  IF (public.phoenix_query_live_inter_org_alert_summary(10))->>'error' IS DISTINCT FROM 'NOT_AUTHENTICATED' THEN
    RAISE EXCEPTION '190 verify failed: the summary query does not refuse an unauthenticated caller';
  END IF;
  IF (public.phoenix_refresh_inter_org_alert_lifecycle(10))->>'error' IS DISTINCT FROM 'NOT_AUTHENTICATED' THEN
    RAISE EXCEPTION '190 verify failed: the refresh COMMAND does not refuse an unauthenticated caller';
  END IF;
  -- …and the refusal is a refusal, not a success carrying zero rows.
  IF COALESCE(((public.phoenix_query_live_inter_org_alert_summary(10))->>'ok')::boolean, true) THEN
    RAISE EXCEPTION '190 verify failed: an unauthenticated summary call reported ok';
  END IF;
END;
$verify$;

COMMIT;

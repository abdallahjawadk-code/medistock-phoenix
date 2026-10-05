-- ===========================================================================
-- PRE3-B / M220 — CENTRAL NEEDS: A MAPPED CENTRAL ITEM MUST EXIST AND BE
--                 ACTIVE (DISPOSITION BOUNDARY + SUBMIT/APPROVE WINDOW)
--
-- WHY THIS MIGRATION EXISTS
--   public.phoenix_central_needs_set_record_disposition (M211, its only
--   definition) checks that a 'mapped' central item EXISTS and never reads its
--   status, although public.central_items.status is one of 'active',
--   'inactive' or 'discontinued' (M001). Nothing downstream re-judges it:
--   set_need_line checks existence only and ties the line to the mapping, the
--   readiness predicate never reads central_items, the M218 submission digest
--   deliberately excludes it, and approve's A2 re-judges organizations and
--   warehouses only. Application users cannot write central_items (M194), but
--   the owner or service_role can change an item's status at any time —
--   before a mapping, after it, after a need line is built on it, or between
--   submit and approve. So an inactive or discontinued item could be mapped
--   by a direct authenticated RPC call (the legacy wrapper included), and a
--   plan referencing one could be submitted and approved.
--
-- THE INVARIANT
--   At the authoritative server boundary a MAPPED central item EXISTS and is
--   ACTIVE: when the mapping is written, when the revision enters SUBMITTED
--   and when it enters APPROVED. Direct RPC calls fail closed.
--
-- WHAT THIS MIGRATION CHANGES (and nothing else)
--   1. public.phoenix_central_needs_set_record_disposition(uuid, text, text,
--      uuid, text) — CREATE OR REPLACE with the M211 body verbatim except the
--      central item check: the item row is read FOR SHARE, a missing item
--      still raises central_item_not_found (P0002), and an existing item that
--      is not 'active' raises the new central_item_not_active (23514, DETAIL
--      "central_item=<uuid> status=<status> reason=<status>"). Same signature
--      and defaults, RETURNS jsonb, SECURITY DEFINER, search_path
--      'public, pg_temp', owner and ACL (CREATE OR REPLACE keeps them; VERIFY
--      proves them byte-identical). Every existing check keeps its order:
--      arguments, session FOR UPDATE, guard, revision load FOR UPDATE, DRAFT,
--      entity, item, the existing mapping FOR UPDATE, idempotent replay,
--      write, audit. The item check still precedes the replay, so replaying a
--      mapping whose item has since become inactive is refused too. The
--      legacy wrapper phoenix_central_needs_set_record_mapping is untouched:
--      it delegates to this function and inherits the guard.
--   2. phoenix_private.central_needs_active_item_gate_v1() — a SECURITY
--      INVOKER trigger function (search_path pg_catalog, pg_temp, no ACL entry
--      but its owner's, every application object qualified, no write, no
--      dynamic SQL). On a status change of a plan revision INTO 'submitted' or
--      'approved' it locks FOR SHARE, ORDER BY id, every central item the
--      revision references — the 'mapped' dispositions of its completed import
--      sessions and its need lines — and refuses with
--      central_needs_central_item_not_active (23514, DETAIL
--      "phase=<submit|approve> revision=<uuid> source=<mapping|need_line> ...
--      central_item=<uuid> status=<status> reason=<status>") if any of them is
--      missing or not active. It judges nothing else and writes nothing.
--   3. Trigger central_needs_plan_revisions_m220_active_item_gate, BEFORE
--      UPDATE FOR EACH ROW, no column list, on that function. By name it fires
--      after the M217 approval fence and the M218 submission fence (so a
--      forged transition is still refused by them first) and before
--      set_updated_at.
--
-- THE LOCK — FOR SHARE, NOT FOR KEY SHARE
--   An UPDATE of central_items.status changes no key column, so it takes FOR
--   NO KEY UPDATE on the row. FOR KEY SHARE (what a foreign-key check takes)
--   does NOT conflict with that and would let the status change commit
--   between the judgement and the write; FOR SHARE does conflict with it. So
--   a status change by anyone (owner or service_role) either commits BEFORE
--   the lock — and the READ COMMITTED re-read of the locked row sees it and
--   the call is refused — or waits until the mapping / transition commits or
--   rolls back. Under REPEATABLE READ or SERIALIZABLE a concurrently changed
--   row raises a serialization failure instead: fail closed either way.
--   Row locks are released only at transaction end.
--
-- THE SUBMIT -> APPROVE WINDOW
--   An item can become inactive after its mapping was written, after a need
--   line was built on it, or between submit and approve. The guard sits on the
--   two transitions that matter — the one write path into SUBMITTED and into
--   APPROVED is an UPDATE of the revision row, which the canonical submit and
--   approve perform as their last step — so every route is covered without
--   replacing submit, approve, readiness or set_need_line, and without
--   touching the M218 digest, attestation or seal. The trigger writes nothing
--   and leaves the revision row untouched, so the M218 SUBMIT attestation
--   (bound to the row's xmin and updated_at) is unaffected. Reject (the
--   remedy), supersede and every DRAFT write pass untouched. A DRAFT may still
--   hold a mapping or need line whose item became inactive after it was
--   written; it can no longer be submitted (residual: readiness does not
--   report it as a blocker — that needs a readiness change, out of scope).
--
-- WHAT THIS MIGRATION IS NOT
--   No table, column, constraint, index, enum, policy, permission key, grant
--   or default privilege; no change to submit, approve, reject, readiness,
--   set_need_line, the digest, the attestation store or the seal; no business
--   row written; no stock, movement, allocation or transfer SQL.
--
-- ACTIVATION
--   READ COMMITTED; applied by the owner of the Central Needs tables, of the
--   replaced function and of phoenix_private, bypassing RLS; M218 present;
--   the replaced function and its wrapper must be exactly their reviewed M211
--   bodies; refuses to run twice. The whole transaction resolves names in
--   pg_catalog, pg_temp only. LOCAL lock_timeout = 250ms, statement_timeout =
--   60s, from the first read on; SHARE ROW EXCLUSIVE NOWAIT on
--   central_needs_plan_revisions (the lock CREATE TRIGGER needs), held to
--   COMMIT: an in-flight revision writer fails M220 closed instead of queuing
--   behind it, and a submit or approve that reaches its transition after
--   COMMIT fires the new trigger. Every other writer (DRAFT editors, catalog
--   and audit writers, any other RPC) keeps working while M220 runs.
--
-- VERIFY JUDGES ONLY WHAT THIS MIGRATION OWNS
--   The objects M220 writes (the disposition RPC's identity, shape, ACL and
--   pinned body; the gate's body, security, search_path, owner and ACL; the
--   trigger's binding and firing order) and the invariants they must keep
--   (M218's seal, service_role surface, private routine set, writer census
--   and trigger inventory). "Nothing else changed" is judged on THIS
--   transaction's own writes, never on whole-table contents: a write census
--   of the rows whose xmin is this transaction's id — in the catalogs of
--   routines, triggers, comments, dependencies, relations, columns,
--   defaults, constraints, indexes, policies, rules, types, schemas, default
--   and initial privileges, event triggers and extensions, and in the
--   catalog item, Central Needs, audit and attestation tables M220's
--   judgement reads or M218 binds — must hold only the RPC, the gate and the
--   trigger (their definitions, comments and dependencies). Writes that
--   other sessions commit while M220 runs carry their own transaction ids,
--   so they can neither fail VERIFY nor satisfy it.
-- ===========================================================================

BEGIN;

-- Every unqualified name in this migration resolves in pg_catalog (and the
-- session's own temporary schema last): nothing in public can shadow it.
SET LOCAL search_path = pg_catalog, pg_temp;
-- Bounded from the first read on (the prelude's reads included): a lock that
-- is not granted at once, or a read that runs away, fails M220 closed.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 0. Preconditions and baselines — catalog reads and plain SELECTs only,
--    BEFORE any lock.
-- ----------------------------------------------------------------------------
DO $prelude$
DECLARE
  v_me     oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_super  boolean;
  v_bypass boolean;
  v_fn     oid := pg_catalog.to_regprocedure('public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text)');
  v_wrap   oid := pg_catalog.to_regprocedure('public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)');
  v_txid   bigint;
  v_xid    xid;
  f        text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '220_requires_read_committed'
      USING DETAIL = pg_catalog.format('transaction_isolation=%s', pg_catalog.current_setting('transaction_isolation'));
  END IF;

  SELECT r.rolsuper, r.rolbypassrls INTO v_super, v_bypass FROM pg_catalog.pg_roles r WHERE r.oid = v_me;
  IF NOT (v_super OR v_bypass) THEN
    RAISE EXCEPTION '220_precondition_failed: the applying role must bypass row-level security'
      USING DETAIL = pg_catalog.format('role=%s', current_user);
  END IF;

  IF pg_catalog.to_regprocedure('phoenix_private.central_needs_active_item_gate_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname = 'central_needs_plan_revisions_m220_active_item_gate') THEN
    RAISE EXCEPTION '220_already_applied';
  END IF;

  -- M220 extends the M218 sealed submission; it is meaningless without it.
  IF pg_catalog.to_regnamespace('phoenix_private') IS NULL
     OR pg_catalog.to_regclass('phoenix_private.central_needs_lifecycle_attestations') IS NULL
     OR pg_catalog.to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                     WHERE t.tgname = 'central_needs_plan_revisions_c6_submission_gate'
                       AND t.tgrelid = pg_catalog.to_regclass('public.central_needs_plan_revisions'))
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                     WHERE t.tgname = 'central_needs_plan_revisions_c5_approval_gate'
                       AND t.tgrelid = pg_catalog.to_regclass('public.central_needs_plan_revisions')) THEN
    RAISE EXCEPTION '220_precondition_failed: M218 (the sealed submission) is not applied';
  END IF;

  FOREACH f IN ARRAY ARRAY[
    'central_items', 'audit_logs', 'central_needs_plan_revisions', 'central_needs_import_sessions',
    'central_needs_record_mappings', 'central_needs_need_lines'
  ] LOOP
    IF pg_catalog.to_regclass('public.' || f) IS NULL THEN
      RAISE EXCEPTION '220_precondition_failed: table % is absent', f;
    END IF;
  END LOOP;

  -- The judged column: central_items.status, text NOT NULL, CHECKed to the
  -- three M001 values.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = 'public.central_items'::pg_catalog.regclass AND a.attname = 'status'
                    AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype AND a.attnotnull AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                     WHERE c.conrelid = 'public.central_items'::pg_catalog.regclass AND c.contype = 'c'
                       AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%status%'
                       AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''active''%'
                       AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''inactive''%'
                       AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''discontinued''%') THEN
    RAISE EXCEPTION '220_precondition_failed: central_items.status is not the M001 text NOT NULL active/inactive/discontinued column';
  END IF;

  -- The replaced function and its wrapper: one definition each, exactly the
  -- reviewed M211 shape and bodies (LF-normalised md5 of prosrc).
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::pg_catalog.regnamespace
         AND p.proname IN ('phoenix_central_needs_set_record_disposition', 'phoenix_central_needs_set_record_mapping')) <> 2 THEN
    RAISE EXCEPTION '220_precondition_failed: the disposition RPC or its wrapper has an overload or is absent';
  END IF;
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = v_fn AND p.prosecdef AND p.prokind = 'f' AND NOT p.proretset
          AND p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
          AND p.prolang = (SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=public, pg_temp']
          AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = '4ea96f468d115bce414d7b0bf2bcf7cf') THEN
    RAISE EXCEPTION '220_precondition_failed: phoenix_central_needs_set_record_disposition is not the reviewed M211 definition';
  END IF;
  IF v_wrap IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = v_wrap AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=public, pg_temp']
          AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = 'e71ae559b00600951180349afcae6fb3') THEN
    RAISE EXCEPTION '220_precondition_failed: phoenix_central_needs_set_record_mapping is not the reviewed M211 wrapper';
  END IF;

  -- The root of trust applies M220: the owner of the replaced function, of the
  -- revisions table (the trigger) and of phoenix_private (the gate function).
  IF (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) <> v_me
     OR (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.central_needs_plan_revisions'::pg_catalog.regclass) <> v_me
     OR (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'phoenix_private') <> v_me THEN
    RAISE EXCEPTION '220_precondition_failed: M220 must be applied by the owner of the disposition RPC, of central_needs_plan_revisions and of phoenix_private'
      USING DETAIL = pg_catalog.format('role=%s', current_user);
  END IF;

  -- Baselines VERIFY compares, never asserts — of what M220 owns only.
  -- (a) the replaced function's identity, shape and exact ACL;
  PERFORM pg_catalog.set_config('phoenix_m220.fn_before', (
    SELECT pg_catalog.format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', p.oid, pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef,
                             p.provolatile, p.proparallel, p.proisstrict, p.proleakproof,
                             pg_catalog.array_to_string(p.proconfig, ','), coalesce(p.proacl::text, '<default>'),
                             pg_catalog.pg_get_function_arguments(p.oid), pg_catalog.pg_get_function_result(p.oid), p.procost)
      FROM pg_catalog.pg_proc p WHERE p.oid = v_fn), true);
  -- (b) the key of VERIFY F's write census: THIS transaction's id, assigned
  --     here, before M220 writes anything (txid_current() is the 64-bit
  --     epoch:xid; a row's xmin holds its low 32 bits). VERIFY judges exactly
  --     the census rows whose xmin is this id. The census rows that ALREADY
  --     carry it now were not written by M220 — only possible past the
  --     cluster's first 32-bit wraparound, where a row frozen in an earlier
  --     epoch keeps a raw xmin a new id can repeat (or for rows this same
  --     transaction wrote before M220 began). They are recorded by position
  --     and identity, and VERIFY ignores exactly them. No other session can
  --     write a row carrying this id.
  v_txid := pg_catalog.txid_current();
  v_xid  := (v_txid % 4294967296)::text::xid;
  PERFORM pg_catalog.set_config('phoenix_m220.txid', v_txid::text, true);
  PERFORM pg_catalog.set_config('phoenix_m220.preexisting', (
    SELECT coalesce(pg_catalog.array_agg(w.rel || '@' || w.k || '@' || w.obj), '{}'::text[])::text
      FROM (SELECT 'pg_proc'::text AS rel, x.ctid::text AS k,
                   pg_catalog.format('%s:%s', 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, x.oid) AS obj
              FROM pg_catalog.pg_proc x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_trigger', x.ctid::text, pg_catalog.format('%s:%s', 'pg_catalog.pg_trigger'::pg_catalog.regclass::pg_catalog.oid, x.oid)
              FROM pg_catalog.pg_trigger x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_description', x.ctid::text, pg_catalog.format('%s:%s', x.classoid, x.objoid)
              FROM pg_catalog.pg_description x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_depend', x.ctid::text, pg_catalog.format('%s:%s', x.classid, x.objid)
              FROM pg_catalog.pg_depend x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_class', x.ctid::text, x.oid::pg_catalog.regclass::text
              FROM pg_catalog.pg_class x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_attribute', x.ctid::text, pg_catalog.format('%s.%s', x.attrelid::pg_catalog.regclass, x.attname)
              FROM pg_catalog.pg_attribute x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_attrdef', x.ctid::text, pg_catalog.format('%s.%s', x.adrelid::pg_catalog.regclass, x.adnum)
              FROM pg_catalog.pg_attrdef x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_constraint', x.ctid::text, x.conname::text
              FROM pg_catalog.pg_constraint x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_index', x.ctid::text, x.indexrelid::pg_catalog.regclass::text
              FROM pg_catalog.pg_index x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_policy', x.ctid::text, x.polname::text
              FROM pg_catalog.pg_policy x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_rewrite', x.ctid::text, x.rulename::text
              FROM pg_catalog.pg_rewrite x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_type', x.ctid::text, x.oid::pg_catalog.regtype::text
              FROM pg_catalog.pg_type x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_namespace', x.ctid::text, x.nspname::text
              FROM pg_catalog.pg_namespace x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_default_acl', x.ctid::text, x.oid::text
              FROM pg_catalog.pg_default_acl x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_init_privs', x.ctid::text, pg_catalog.format('privs %s/%s', x.classoid, x.objoid)
              FROM pg_catalog.pg_init_privs x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_event_trigger', x.ctid::text, x.evtname::text
              FROM pg_catalog.pg_event_trigger x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_extension', x.ctid::text, x.extname::text
              FROM pg_catalog.pg_extension x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_items', x.ctid::text, x.id::text
              FROM public.central_items x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_plan_revisions', x.ctid::text, x.id::text
              FROM public.central_needs_plan_revisions x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_import_sessions', x.ctid::text, x.id::text
              FROM public.central_needs_import_sessions x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_record_mappings', x.ctid::text, x.id::text
              FROM public.central_needs_record_mappings x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_need_lines', x.ctid::text, x.id::text
              FROM public.central_needs_need_lines x WHERE x.xmin = v_xid
            UNION ALL SELECT 'audit_logs', x.ctid::text, x.id::text
              FROM public.audit_logs x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_lifecycle_attestations', x.ctid::text, x.id::text
              FROM phoenix_private.central_needs_lifecycle_attestations x WHERE x.xmin = v_xid) w), true);
END
$prelude$;

-- ----------------------------------------------------------------------------
-- 0b. The activation lock, held to COMMIT: SHARE ROW EXCLUSIVE (what CREATE
--     TRIGGER takes) on the revisions table, NOWAIT. It conflicts with every
--     row writer of the table (submit, approve, reject, open, correction), so
--     none is half-way through a transition while the trigger is attached;
--     readers and the DRAFT editors' FOR UPDATE row locks continue.
-- ----------------------------------------------------------------------------
LOCK TABLE public.central_needs_plan_revisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- ----------------------------------------------------------------------------
-- 1. The disposition RPC — the M211 body verbatim except the central item
--    check (and its one new variable). CREATE OR REPLACE keeps the owner and
--    the ACL; nothing here grants or revokes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_record_disposition(
  p_import_session_id uuid,
  p_target_entity     text,
  p_decision          text,
  p_central_item_id   uuid   DEFAULT NULL,
  p_decision_reason   text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_session    public.central_needs_import_sessions%ROWTYPE;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_entity     text := NULLIF(btrim(p_target_entity), '');
  v_decision   text := NULLIF(btrim(p_decision), '');
  v_reason     text := NULLIF(btrim(p_decision_reason), '');
  v_item       uuid;
  v_item_label text;
  v_item_status text;
  v_existing   public.central_needs_record_mappings%ROWTYPE;
  v_row        public.central_needs_record_mappings%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_import_session_id IS NULL THEN
    RAISE EXCEPTION 'import_session_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_entity IS NULL THEN
    RAISE EXCEPTION 'target_entity_required' USING ERRCODE = '23514';
  END IF;
  IF v_decision IS NULL OR v_decision NOT IN ('mapped', 'not_applicable') THEN
    RAISE EXCEPTION 'decision_must_be_mapped_or_not_applicable' USING ERRCODE = '23514',
      DETAIL = format('decision=%s', COALESCE(v_decision, '<null>'));
  END IF;

  -- Shape the two cases before any write so the table CHECK is a backstop,
  -- never the primary error surface.
  IF v_decision = 'mapped' THEN
    IF p_central_item_id IS NULL THEN
      RAISE EXCEPTION 'mapped_decision_requires_central_item_id' USING ERRCODE = '23514';
    END IF;
    v_item := p_central_item_id;
  ELSE
    IF p_central_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'not_applicable_decision_must_not_carry_central_item_id' USING ERRCODE = '23514';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'not_applicable_decision_requires_reason' USING ERRCODE = '23514',
        HINT = 'Record why this row carries no central item — a subtotal, a note, a header remnant or a continuation of the row above.';
    END IF;
    v_item := NULL;
  END IF;

  SELECT * INTO v_session
    FROM public.central_needs_import_sessions
   WHERE id = p_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'import_session_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- load -> authorize -> assert-editable, so an unauthorized caller never
  -- learns the workflow state of a revision they may not see.
  v_actor_role := public._phoenix_central_needs_guard_v1(v_session.organization_id, 'central_needs.edit');
  v_revision   := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);

  IF NOT EXISTS (
    SELECT 1 FROM public.central_needs_source_records
     WHERE import_session_id = p_import_session_id AND target_entity = v_entity
  ) THEN
    RAISE EXCEPTION 'target_entity_not_in_import_session' USING ERRCODE = 'P0002',
      DETAIL = format('session=%s target_entity=%s', p_import_session_id, v_entity),
      HINT = 'Only an entity present in this session''s authoritative source evidence can carry a disposition.';
  END IF;

  IF v_item IS NOT NULL THEN
    -- 220 (PRE3-B): the mapped item must EXIST and be ACTIVE. FOR SHARE (not
    -- FOR KEY SHARE: a status change takes FOR NO KEY UPDATE, which only FOR
    -- SHARE and stronger conflict with) holds the row to transaction end, so
    -- no status change commits between this judgement and the write below; a
    -- change committed first is what this READ COMMITTED re-read returns.
    SELECT ci.name, ci.status INTO v_item_label, v_item_status
      FROM public.central_items ci
     WHERE ci.id = v_item
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_item_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'central_item_not_active' USING ERRCODE = '23514',
        DETAIL = format('central_item=%s status=%s reason=%s', v_item, v_item_status, v_item_status),
        HINT = 'Only an active central item can be mapped. Choose an active catalog item, or mark the row not applicable with a reason.';
    END IF;
  END IF;

  SELECT * INTO v_existing
    FROM public.central_needs_record_mappings
   WHERE import_session_id = p_import_session_id AND target_entity = v_entity
   FOR UPDATE;

  IF FOUND
     AND v_existing.decision = v_decision
     AND v_existing.central_item_id IS NOT DISTINCT FROM v_item
     AND v_existing.decision_reason IS NOT DISTINCT FROM v_reason THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'mapping_id', v_existing.id, 'import_session_id', p_import_session_id,
      'target_entity', v_entity, 'decision', v_decision,
      'central_item_id', v_item
    );
  END IF;

  INSERT INTO public.central_needs_record_mappings (
    import_session_id, organization_id, target_entity, central_item_id,
    decision, decision_reason, mapped_by, decided_by, decided_at
  ) VALUES (
    p_import_session_id, v_session.organization_id, v_entity, v_item,
    v_decision, v_reason, v_actor, v_actor, now()
  )
  ON CONFLICT (import_session_id, target_entity) DO UPDATE
    SET central_item_id  = EXCLUDED.central_item_id,
        decision         = EXCLUDED.decision,
        decision_reason  = EXCLUDED.decision_reason,
        mapped_by        = EXCLUDED.mapped_by,
        decided_by       = EXCLUDED.decided_by,
        decided_at       = EXCLUDED.decided_at
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_session.organization_id, v_actor, v_actor_role,
    'central_needs.record_disposition.set', 'central_needs_record_mapping', v_row.id,
    COALESCE(v_item_label, v_entity),
    jsonb_build_object(
      'import_session_id', p_import_session_id,
      'plan_revision_id', v_session.plan_revision_id,
      'source_file_id', v_session.source_file_id,
      'target_entity', v_entity,
      'decision', v_decision,
      'decision_reason', v_reason,
      'central_item_id', v_item,
      'previous_decision', v_existing.decision,
      'previous_central_item_id', v_existing.central_item_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'mapping_id', v_row.id, 'import_session_id', p_import_session_id,
    'target_entity', v_entity, 'decision', v_decision,
    'central_item_id', v_item,
    'previous_decision', v_existing.decision,
    'previous_central_item_id', v_existing.central_item_id
  );
END;
$$;

-- CREATE OR REPLACE keeps this function's owner and privileges (REVOKE ALL
-- FROM PUBLIC, anon and EXECUTE for authenticated per M211; no service_role
-- EXECUTE per M218); nothing here grants or revokes.

COMMENT ON FUNCTION public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text) IS
  'CN-2B (211, PRE3-B 220): records the explicit human disposition of one imported target_entity — ''mapped'' with an EXISTING and ACTIVE central item (read FOR SHARE: central_item_not_found / central_item_not_active), or ''not_applicable'' with a mandatory reason. Draft revisions only, central_needs.edit, exact organization boundary, archived organizations refused, fully audited. Never infers a decision.';

-- ----------------------------------------------------------------------------
-- 2. The active-item gate — private, SECURITY INVOKER (it runs with the rights
--    of the owner-run submit / approve that fire it, or of a root writer), no
--    ACL entry but its owner's. Judges exactly a status change INTO submitted
--    or approved; writes nothing.
-- ----------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_active_item_gate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_phase text;
  v_bad   record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IN ('submitted', 'approved')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_phase := CASE NEW.status WHEN 'submitted' THEN 'submit' ELSE 'approve' END;

    -- Every central item the revision references, FOR SHARE, ORDER BY id: no
    -- status change commits until this transaction ends, and one committed
    -- before this lock is what the judgement below reads.
    PERFORM 1
      FROM public.central_items ci
     WHERE ci.id IN (SELECT m.central_item_id
                       FROM public.central_needs_record_mappings m
                       JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id
                      WHERE s.plan_revision_id = NEW.id
                        AND s.status = 'completed'
                        AND m.decision = 'mapped'
                     UNION
                     SELECT n.central_item_id
                       FROM public.central_needs_need_lines n
                      WHERE n.plan_revision_id = NEW.id)
     ORDER BY ci.id
       FOR SHARE;

    SELECT x.central_item_id, x.ref, ci.status
      INTO v_bad
      FROM (SELECT m.central_item_id, 1 AS src_rank, m.id AS ref_id,
                   format('source=mapping mapping=%s session=%s target_entity=%s', m.id, m.import_session_id, m.target_entity) AS ref
              FROM public.central_needs_record_mappings m
              JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id
             WHERE s.plan_revision_id = NEW.id
               AND s.status = 'completed'
               AND m.decision = 'mapped'
            UNION ALL
            SELECT n.central_item_id, 2, n.id,
                   format('source=need_line need_line=%s', n.id)
              FROM public.central_needs_need_lines n
             WHERE n.plan_revision_id = NEW.id) x
      LEFT JOIN public.central_items ci ON ci.id = x.central_item_id
     WHERE ci.id IS NULL OR ci.status IS DISTINCT FROM 'active'
     ORDER BY x.central_item_id, x.src_rank, x.ref_id
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'central_needs_central_item_not_active' USING ERRCODE = '23514',
        DETAIL = format('phase=%s revision=%s %s central_item=%s status=%s reason=%s', v_phase, NEW.id, v_bad.ref,
                        v_bad.central_item_id, coalesce(v_bad.status, 'not_found'), coalesce(v_bad.status, 'not_found')),
        HINT = CASE v_phase
                 WHEN 'submit' THEN 'Every mapped row and need line must reference an active central item. Map those rows to an active item in the draft, then submit.'
                 ELSE 'A central item of this revision became inactive after submission. Reject the revision and correct it through a new draft.'
               END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION phoenix_private.central_needs_active_item_gate_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION phoenix_private.central_needs_active_item_gate_v1() IS
  'PRE3-B (220) internal: the active-item gate. BEFORE UPDATE on central_needs_plan_revisions, a status change INTO submitted or approved locks FOR SHARE (ORDER BY id) every central item the revision references — mapped dispositions of its completed sessions and its need lines — and refuses central_needs_central_item_not_active (phase, revision, source, item, status, reason) if one is missing or not active. Writes nothing. Not reachable by any non-root role.';

-- ----------------------------------------------------------------------------
-- 3. The ONE new trigger: BEFORE UPDATE, no column list. By name it fires
--    after central_needs_plan_revisions_c5_approval_gate and
--    central_needs_plan_revisions_c6_submission_gate and before set_updated_at.
-- ----------------------------------------------------------------------------
CREATE TRIGGER central_needs_plan_revisions_m220_active_item_gate
  BEFORE UPDATE ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_active_item_gate_v1();

COMMENT ON TRIGGER central_needs_plan_revisions_m220_active_item_gate ON public.central_needs_plan_revisions IS
  'PRE3-B (220): the active-item gate — a revision enters submitted or approved only while every central item it references exists and is active.';

-- ----------------------------------------------------------------------------
-- 4. VERIFY — catalog reads and plain SELECTs. Fails the migration rather than
--    ship a half-applied contract.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_me    oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_fn    oid := pg_catalog.to_regprocedure('public.phoenix_central_needs_set_record_disposition(uuid, text, text, uuid, text)');
  v_gate  oid := pg_catalog.to_regprocedure('phoenix_private.central_needs_active_item_gate_v1()');
  v_priv  oid := pg_catalog.to_regnamespace('phoenix_private');
  v_trig  oid;
  v_xid   xid;
  v_src   text;
  v_code  text;
  v_load  integer;
  v_draft integer;
  v_lock  integer;
  v_judge integer;
  v_write integer;
BEGIN
  -- A. The disposition RPC: same oid, owner, SECURITY DEFINER, volatility,
  --    search_path, exact ACL, arguments (with defaults) and result.
  IF v_fn IS NULL OR (SELECT pg_catalog.format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', p.oid, pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef,
                             p.provolatile, p.proparallel, p.proisstrict, p.proleakproof,
                             pg_catalog.array_to_string(p.proconfig, ','), coalesce(p.proacl::text, '<default>'),
                             pg_catalog.pg_get_function_arguments(p.oid), pg_catalog.pg_get_function_result(p.oid), p.procost)
                        FROM pg_catalog.pg_proc p WHERE p.oid = v_fn)
                     IS DISTINCT FROM pg_catalog.current_setting('phoenix_m220.fn_before') THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC changed identity, owner, shape, search_path or ACL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_fn AND p.prosecdef AND p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND pg_catalog.pg_get_function_identity_arguments(p.oid)
                        = 'p_import_session_id uuid, p_target_entity text, p_decision text, p_central_item_id uuid, p_decision_reason text') THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC must stay SECURITY DEFINER (uuid, text, text, uuid, text) RETURNS jsonb with search_path public, pg_temp';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                 WHERE p.oid = v_fn AND a.grantee = 0) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC must be EXECUTE for authenticated only (no PUBLIC, no anon)';
  END IF;

  -- B. The active-item predicate, its lock and the F2 order: load the revision
  --    FOR UPDATE, assert DRAFT, lock and judge the item, then the first write.
  v_src   := pg_catalog.regexp_replace((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = v_fn), '--[^\n]*', '', 'g');
  v_load  := pg_catalog.strpos(v_src, 'public._phoenix_central_needs_load_revision_v1(');
  v_draft := pg_catalog.strpos(v_src, 'public._phoenix_central_needs_assert_draft_v1(');
  v_lock  := pg_catalog.strpos(v_src, E'FROM public.central_items ci\n     WHERE ci.id = v_item\n       FOR SHARE;');
  v_judge := pg_catalog.strpos(v_src, 'IF v_item_status IS DISTINCT FROM ''active'' THEN');
  v_write := coalesce((SELECT pg_catalog.min(pg_catalog.strpos(v_src, m[1]))
                         FROM pg_catalog.regexp_matches(v_src, '((insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?(public|phoenix_private)\.central_needs_[a-z_]+)', 'gi') AS m), 0);
  IF v_load = 0 OR v_draft = 0 OR v_lock = 0 OR v_judge = 0 OR v_write = 0
     OR NOT (v_load < v_draft AND v_draft < v_lock AND v_lock < v_judge AND v_judge < v_write) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC must load the revision, assert DRAFT, lock and judge the item FOR SHARE, then write';
  END IF;
  IF pg_catalog.strpos(v_src, 'RAISE EXCEPTION ''central_item_not_found'' USING ERRCODE = ''P0002'';') = 0
     OR pg_catalog.strpos(v_src, 'RAISE EXCEPTION ''central_item_not_active'' USING ERRCODE = ''23514'',') = 0
     OR pg_catalog.strpos(v_src, 'DETAIL = format(''central_item=%s status=%s reason=%s'', v_item, v_item_status, v_item_status),') = 0
     OR pg_catalog.strpos(v_src, 'RAISE EXCEPTION ''central_item_not_found''') > v_judge
     OR pg_catalog.strpos(v_src, 'FOR KEY SHARE') > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC must keep central_item_not_found and raise central_item_not_active with its reason token';
  END IF;
  IF v_src ~* '\mexecute\M' THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC uses dynamic SQL';
  END IF;
  -- The whole reviewed body, byte for byte (LF-normalised md5 of prosrc).
  IF (SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc p WHERE p.oid = v_fn)
     IS DISTINCT FROM '28c3235fa7cf01bf76c3ac24d24e76f8' THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC body is not the reviewed M220 body';
  END IF;
  -- The legacy wrapper is the reviewed M211 body and still delegates.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_central_needs_set_record_mapping(uuid, text, uuid)')
                    AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = 'e71ae559b00600951180349afcae6fb3'
                    AND pg_catalog.strpos(p.prosrc, 'public.phoenix_central_needs_set_record_disposition(') > 0) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the legacy wrapper is not the M211 delegation';
  END IF;

  -- C. The gate function: private, SECURITY INVOKER, pinned search_path, no
  --    ACL entry but its owner's, owned by the migration owner, no write, no
  --    dynamic SQL, every application object qualified, the predicate and lock.
  IF v_gate IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = v_gate AND p.pronamespace = v_priv AND NOT p.prosecdef AND p.proowner = v_me
          AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the gate must be a SECURITY INVOKER trigger function in phoenix_private, owned by the migration owner, pinned to pg_catalog, pg_temp';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              WHERE p.oid = v_gate AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the gate carries an ACL entry for a role other than its owner';
  END IF;
  v_src := pg_catalog.regexp_replace((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = v_gate), '--[^\n]*', '', 'g');
  IF pg_catalog.strpos(v_src, E'IF TG_OP = ''UPDATE''\n     AND NEW.status IN (''submitted'', ''approved'')\n     AND OLD.status IS DISTINCT FROM NEW.status THEN') = 0
     OR pg_catalog.strpos(v_src, E'ORDER BY ci.id\n       FOR SHARE;') = 0
     OR pg_catalog.strpos(v_src, 'WHERE ci.id IS NULL OR ci.status IS DISTINCT FROM ''active''') = 0
     OR pg_catalog.strpos(v_src, 'RAISE EXCEPTION ''central_needs_central_item_not_active'' USING ERRCODE = ''23514'',') = 0
     OR pg_catalog.strpos(v_src, 'FOR KEY SHARE') > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the gate must lock every referenced item FOR SHARE and refuse a non-active one on entry into submitted or approved';
  END IF;
  IF v_src ~* '\mexecute\M'
     OR v_src ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+'
     OR v_src ~* '(from|join|into|update|table)\s+(only\s+)?"?(central_needs_|central_items|audit_logs|organizations|warehouses|profiles)' THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the gate writes, uses dynamic SQL or names an application relation without its schema';
  END IF;
  IF (SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc p WHERE p.oid = v_gate)
     IS DISTINCT FROM 'd82c23813d1c01260830c2bda5d4c691' THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the gate body is not the reviewed M220 body';
  END IF;

  -- D. The trigger: exactly one, BEFORE UPDATE FOR EACH ROW, enabled, no
  --    column list, firing after both M217/M218 fences and before
  --    set_updated_at; the Central Needs trigger inventory is M218's frozen set
  --    plus exactly this one.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.central_needs_plan_revisions'::pg_catalog.regclass
                    AND t.tgname = 'central_needs_plan_revisions_m220_active_item_gate'
                    AND t.tgfoid = v_gate AND t.tgtype = 19 AND t.tgenabled = 'O' AND NOT t.tgisinternal
                    AND pg_catalog.cardinality(t.tgattr::pg_catalog.int2[]) = 0)
     OR NOT ('central_needs_plan_revisions_c5_approval_gate' COLLATE "C" < 'central_needs_plan_revisions_m220_active_item_gate' COLLATE "C"
             AND 'central_needs_plan_revisions_c6_submission_gate' COLLATE "C" < 'central_needs_plan_revisions_m220_active_item_gate' COLLATE "C"
             AND 'central_needs_plan_revisions_m220_active_item_gate' COLLATE "C" < 'set_updated_at' COLLATE "C") THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the active-item trigger is missing, misbound or misordered';
  END IF;
  IF (SELECT pg_catalog.array_agg(s.x ORDER BY s.x COLLATE "C")
        FROM (SELECT pg_catalog.format('%s|%s|%s.%s|%s|%s|%s', c.relname, t.tgname, pn.nspname, p.proname,
                                       t.tgtype, t.tgenabled, pg_catalog.cardinality(t.tgattr::pg_catalog.int2[])) AS x
                FROM pg_catalog.pg_trigger t
                JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
                JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
               WHERE t.tgrelid IN ('public.central_needs_plans'::pg_catalog.regclass, 'public.central_needs_plan_revisions'::pg_catalog.regclass, 'public.central_needs_source_files'::pg_catalog.regclass, 'public.central_needs_import_sessions'::pg_catalog.regclass, 'public.central_needs_source_records'::pg_catalog.regclass, 'public.central_needs_record_mappings'::pg_catalog.regclass, 'public.central_needs_field_overrides'::pg_catalog.regclass, 'public.central_needs_import_batches'::pg_catalog.regclass, 'public.central_needs_import_batch_entries'::pg_catalog.regclass, 'public.central_needs_beneficiary_column_mappings'::pg_catalog.regclass, 'public.central_needs_beneficiary_regions'::pg_catalog.regclass, 'public.central_needs_need_lines'::pg_catalog.regclass, 'public.central_needs_need_line_sources'::pg_catalog.regclass) AND NOT t.tgisinternal) s)
     IS DISTINCT FROM ARRAY['central_needs_beneficiary_column_mappings|assert_beneficiary_region_grain|public._phoenix_central_needs_assert_region_geometry_v1|21|O|0',
                         'central_needs_beneficiary_column_mappings|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|25|O|0',
                         'central_needs_beneficiary_column_mappings|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_beneficiary_regions|assert_beneficiary_region_geometry|public._phoenix_central_needs_assert_region_geometry_v1|21|O|0',
                         'central_needs_beneficiary_regions|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|29|O|0',
                         'central_needs_beneficiary_regions|central_needs_beneficiary_regions_guard|public._phoenix_central_needs_region_version_guard_v1|31|O|0',
                         'central_needs_need_line_sources|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|29|O|0',
                         'central_needs_need_lines|assert_need_line_integrity|public._phoenix_central_needs_assert_need_line_integrity_v1|21|O|0',
                         'central_needs_need_lines|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_plan_revisions|central_needs_plan_revisions_c5_approval_gate|public._phoenix_central_needs_approval_gate_fence_v1|23|O|0',
                         'central_needs_plan_revisions|central_needs_plan_revisions_c6_submission_gate|phoenix_private.central_needs_submission_gate_fence_v1|19|O|0',
                         'central_needs_plan_revisions|central_needs_plan_revisions_m220_active_item_gate|phoenix_private.central_needs_active_item_gate_v1|19|O|0',
                         'central_needs_plan_revisions|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_plans|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_record_mappings|set_updated_at|public.phoenix_set_updated_at|19|O|0',
                         'central_needs_source_files|central_needs_source_files_immutable|public._phoenix_central_needs_source_immutability_v1|19|O|0',
                         'central_needs_source_records|central_needs_source_records_immutable|public._phoenix_central_needs_source_immutability_v1|19|O|0'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the Central Needs trigger inventory is not exactly M218''s frozen set plus the active-item gate';
  END IF;

  -- E. M218 still holds: the seal predicate is empty; service_role's Central
  --    Needs SECURITY DEFINER surface is exactly the three trusted routines;
  --    phoenix_private is owner-only and holds the four M218 routines plus the
  --    gate, every one SECURITY INVOKER, pinned and owner-only; the writer
  --    census is unchanged and no Central Needs routine uses dynamic SQL.
  SELECT pg_catalog.string_agg(b.breach, '; ' ORDER BY b.breach) INTO v_code
    FROM phoenix_private.central_needs_capability_breaches_v1() AS b(breach);
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): a non-root capability exists: %', v_code;
  END IF;
  IF (SELECT pg_catalog.array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C")
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname LIKE '%central\_needs\_%' AND p.prosecdef
         AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
     IS DISTINCT FROM ARRAY['_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_register_import_batch'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): service_role Central Needs SECURITY DEFINER EXECUTE is not exactly the three trusted routines';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
              CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
              WHERE n.oid = v_priv AND a.grantee <> n.nspowner)
     OR (SELECT pg_catalog.array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C") FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_priv)
        IS DISTINCT FROM ARRAY['central_needs_active_item_gate_v1', 'central_needs_approval_gate_fence_v1', 'central_needs_capability_breaches_v1',
                               'central_needs_submission_gate_fence_v1', 'central_needs_submission_state_digest_v1']
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_priv
                   AND (p.prosecdef OR p.proowner <> v_me OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                 CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                 WHERE p.pronamespace = v_priv AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): phoenix_private must stay owner-only with exactly the four M218 routines and the gate, each SECURITY INVOKER and pinned';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C")
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
         AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
             ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.|"?phoenix_private"?\.)?"?central_needs_[a-z_]+')
     IS DISTINCT FROM ARRAY['phoenix_central_needs_abandon_import_session',
                         'phoenix_central_needs_apply_authoritative_replay',
                         'phoenix_central_needs_approve_revision',
                         'phoenix_central_needs_delete_need_line',
                         'phoenix_central_needs_open_correction_revision',
                         'phoenix_central_needs_open_plan_revision',
                         'phoenix_central_needs_record_field_override',
                         'phoenix_central_needs_register_import_batch',
                         'phoenix_central_needs_reject_revision',
                         'phoenix_central_needs_set_beneficiary_columns',
                         'phoenix_central_needs_set_beneficiary_regions',
                         'phoenix_central_needs_set_need_line',
                         'phoenix_central_needs_set_record_disposition',
                         'phoenix_central_needs_start_import_entry_session',
                         'phoenix_central_needs_submit_revision'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the Central Needs writer census changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
                AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M'
                AND p.prosrc ~* 'central_needs_') THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): a routine that mentions Central Needs uses dynamic SQL';
  END IF;

  -- F. Nothing else changed — judged on THIS transaction's own writes, never
  --    on whole-table contents. (1) The census key is the transaction that
  --    wrote M220's own objects: the disposition RPC's and the gate's pg_proc
  --    rows and the trigger's pg_trigger row all carry the id the prelude
  --    recorded (one plain transaction, no per-statement savepoints). (2) No
  --    OTHER census row carries it — no other routine, trigger, comment,
  --    dependency, relation, column, default, constraint, index, policy, rule,
  --    type, schema, default or initial privilege, event trigger or extension,
  --    and no catalog item, Central Needs, audit or attestation row — except
  --    the rows that already carried it before M220 wrote anything (the
  --    prelude's record). Rows other sessions commit meanwhile carry their own
  --    ids and are never judged. DROP, DELETE and TRUNCATE leave no row to
  --    census: this file has none (220 static test), and A-E pin the exact
  --    inventories they could shrink.
  v_xid  := (pg_catalog.current_setting('phoenix_m220.txid')::bigint % 4294967296)::text::xid;
  v_trig := (SELECT t.oid FROM pg_catalog.pg_trigger t
              WHERE t.tgrelid = 'public.central_needs_plan_revisions'::pg_catalog.regclass
                AND t.tgname = 'central_needs_plan_revisions_m220_active_item_gate');
  IF pg_catalog.txid_current() IS DISTINCT FROM pg_catalog.current_setting('phoenix_m220.txid')::bigint
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (v_fn, v_gate) AND p.xmin = v_xid) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.oid = v_trig AND t.xmin = v_xid) THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): the disposition RPC, the gate and the trigger were not all written by this one transaction';
  END IF;
  SELECT pg_catalog.string_agg(w.rel || ' ' || w.obj, '; ' ORDER BY w.rel, w.obj) INTO v_code
      FROM (SELECT 'pg_proc'::text AS rel, x.ctid::text AS k,
                   pg_catalog.format('%s:%s', 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, x.oid) AS obj
              FROM pg_catalog.pg_proc x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_trigger', x.ctid::text, pg_catalog.format('%s:%s', 'pg_catalog.pg_trigger'::pg_catalog.regclass::pg_catalog.oid, x.oid)
              FROM pg_catalog.pg_trigger x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_description', x.ctid::text, pg_catalog.format('%s:%s', x.classoid, x.objoid)
              FROM pg_catalog.pg_description x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_depend', x.ctid::text, pg_catalog.format('%s:%s', x.classid, x.objid)
              FROM pg_catalog.pg_depend x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_class', x.ctid::text, x.oid::pg_catalog.regclass::text
              FROM pg_catalog.pg_class x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_attribute', x.ctid::text, pg_catalog.format('%s.%s', x.attrelid::pg_catalog.regclass, x.attname)
              FROM pg_catalog.pg_attribute x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_attrdef', x.ctid::text, pg_catalog.format('%s.%s', x.adrelid::pg_catalog.regclass, x.adnum)
              FROM pg_catalog.pg_attrdef x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_constraint', x.ctid::text, x.conname::text
              FROM pg_catalog.pg_constraint x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_index', x.ctid::text, x.indexrelid::pg_catalog.regclass::text
              FROM pg_catalog.pg_index x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_policy', x.ctid::text, x.polname::text
              FROM pg_catalog.pg_policy x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_rewrite', x.ctid::text, x.rulename::text
              FROM pg_catalog.pg_rewrite x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_type', x.ctid::text, x.oid::pg_catalog.regtype::text
              FROM pg_catalog.pg_type x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_namespace', x.ctid::text, x.nspname::text
              FROM pg_catalog.pg_namespace x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_default_acl', x.ctid::text, x.oid::text
              FROM pg_catalog.pg_default_acl x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_init_privs', x.ctid::text, pg_catalog.format('privs %s/%s', x.classoid, x.objoid)
              FROM pg_catalog.pg_init_privs x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_event_trigger', x.ctid::text, x.evtname::text
              FROM pg_catalog.pg_event_trigger x WHERE x.xmin = v_xid
            UNION ALL SELECT 'pg_extension', x.ctid::text, x.extname::text
              FROM pg_catalog.pg_extension x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_items', x.ctid::text, x.id::text
              FROM public.central_items x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_plan_revisions', x.ctid::text, x.id::text
              FROM public.central_needs_plan_revisions x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_import_sessions', x.ctid::text, x.id::text
              FROM public.central_needs_import_sessions x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_record_mappings', x.ctid::text, x.id::text
              FROM public.central_needs_record_mappings x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_need_lines', x.ctid::text, x.id::text
              FROM public.central_needs_need_lines x WHERE x.xmin = v_xid
            UNION ALL SELECT 'audit_logs', x.ctid::text, x.id::text
              FROM public.audit_logs x WHERE x.xmin = v_xid
            UNION ALL SELECT 'central_needs_lifecycle_attestations', x.ctid::text, x.id::text
              FROM phoenix_private.central_needs_lifecycle_attestations x WHERE x.xmin = v_xid) w
   WHERE (w.rel || '@' || w.k || '@' || w.obj) <> ALL (pg_catalog.current_setting('phoenix_m220.preexisting')::text[])
     AND w.obj <> ALL (ARRAY[pg_catalog.format('%s:%s', 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, v_fn),
                             pg_catalog.format('%s:%s', 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, v_gate),
                             pg_catalog.format('%s:%s', 'pg_catalog.pg_trigger'::pg_catalog.regclass::pg_catalog.oid, v_trig)]);
  IF v_code IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (220): this transaction wrote beyond the disposition RPC, the gate and its trigger: %', v_code;
  END IF;
END
$verify$;

COMMIT;

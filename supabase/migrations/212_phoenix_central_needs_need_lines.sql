-- ===========================================================================
-- CN-2B CONFORMANCE CORRECTION (212) — the operational Annual Needs projection.
--
-- WHY THIS MIGRATION EXISTS
--
-- v7.3 section 8.1 requires that operational identity and constraints be
-- RELATIONAL: "plan_id, revision_id, organization_id, target_warehouse_id,
-- central_item_id, canonical material identity fields, ... approved/final
-- quantities ... These are real columns so Phoenix can enforce FK, UNIQUE,
-- indexes, authorization, idempotency, joins, reporting. Do not hide these in
-- JSONB." Section 20 requires CN-2B to "map institution/material/unit".
--
-- What M209/M210/M211 actually shipped satisfies most of the contract but not
-- all of it. A conformance audit against v7.3 established:
--
--     material mapping            PRESENT  (record_mappings.central_item_id)
--     business-field overrides    PRESENT  (field_overrides, blessed as JSONB
--                                           by v7.3 section 8.4)
--     revision workflow           PRESENT
--     source evidence             PRESENT  (+ immutability trigger)
--     institution mapping         MISSING
--     unit mapping                MISSING
--     approved quantity           MISSING as a relational value
--     beneficiary dimension       MISSING entirely
--
-- The beneficiary gap is the load-bearing one. `central_needs_plans
-- .organization_id` is the OWNING/authorizing central organization — it is what
-- `_phoenix_central_needs_guard_v1` authorizes against and what every RLS
-- policy reads, and `UNIQUE (organization_id, plan_year)` means one plan per
-- owning org per year. It therefore cannot also denote the institution whose
-- requirement a line belongs to: a single archive carries many institutions'
-- requirements. That column is NOT repurposed here.
--
-- So this migration adds the smallest additive relational projection that lets
-- a human's CN-2B mapping be persisted, and nothing else. It is a STAGE 2
-- CONFORMANCE CORRECTION, not Stage 3: it computes no remaining need, touches
-- no stock, creates no lineage to a transfer line, and introduces no
-- allocation. Those remain CN-4A's scope.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * no ALTER of M209/M210/M211 objects other than CREATE OR REPLACE of the
--     internal blockers function, whose five existing branches are reproduced
--     verbatim and only extended;
--   * no column on any stock/movement table, no second stock ledger, no second
--     transfer engine, no second audit framework (v7.3 section 0/2);
--   * no touch of inventory_transfer_suggestions (v7.3 section 3);
--   * NO BACKFILL of any kind. Existing 2026 evidence is untouched; an
--     operational need line exists only where a human created one.
--
-- HISTORICAL APPROVED REVISIONS (v7.3 section 11.2 / owner decision)
--   The new completeness blockers are evaluated only by
--   `_phoenix_central_needs_review_blockers_v1`, which is consulted by
--   `phoenix_central_needs_review_readiness` and by the submit gate — both of
--   which act on a revision that is still being prepared. An already-approved
--   revision is never re-validated, so no historical approval can be
--   retroactively invalidated by this migration. A revision approved before
--   212 simply remains historical evidence with zero need lines; mapping
--   happens in the next revision opened for that plan. This is asserted by the
--   dynamic suite, not merely argued here.
--
-- QUANTITY REPRESENTATION (owner decision 4; independent review blocker 5)
--   UNCONSTRAINED `numeric` — no typmod at all. An earlier revision of this
--   migration declared `numeric(20,3)` on the theory that 3 decimals is this
--   repository's exact-decimal precedent (unit_price in 060/061/067/068/069/071,
--   item_availability.price in 020). That was wrong for THIS column, and
--   measurably so: PostgreSQL does not reject a value whose scale exceeds the
--   declared scale, it SILENTLY ROUNDS it. Measured on PostgreSQL 17.10:
--
--       SELECT '120.1239'::numeric(20,3);  -->  120.124      (silent round)
--       SELECT '120.1239'::numeric;        -->  120.1239     (exact)
--
--   The owner decision forbids rounding during mapping, so the type carries no
--   scale and the value is stored exactly as designated. Integer was never an
--   option for the same reason.
--
--   `numeric` without a typmod also admits the two non-finite values a typmod
--   would have partly screened, and `>= 0` does NOT exclude them: in PostgreSQL
--   NaN compares GREATER than every number, so `NaN >= 0` is true. Both are
--   therefore rejected explicitly by CHECK, fail-closed:
--
--       CHECK (approved_quantity <> 'NaN'::numeric)        -- NaN = NaN is true
--       CHECK (approved_quantity < 'Infinity'::numeric)    -- +Infinity (PG14+)
--
--   Zero is a valid approved quantity; blank is not zero and is simply no row.
--
-- UNIT REPRESENTATION (owner decision 4)
--   There is no unit catalog table in this schema. The canonical controlled
--   vocabulary is `central_items.unit`'s CHECK list, so that exact list is
--   reused and server-validated here rather than inventing a second catalog.
--   When a source quantity cannot yet be expressed in that vocabulary the line
--   records `unit_conversion_state = 'conversion_required'` and carries NO
--   canonical unit — the conversion is never guessed — and such a line blocks
--   approval until a human resolves it.
--
-- PROVEN CARDINALITY (owner section 11; independent reviews 1 and 2)
--   The keys below are NOT assumed. They follow from MEASURING the real corpus
--   — the 2026 Annual Needs archive, SHA-256
--   b00208ca019c8735790c5401dee26d986234a12279d04e0a057f278bd99eaca2, read
--   read-only and run through this repository's OWN import parser
--   (src/features/central-needs/import/node-replay.ts: vendored SheetJS 0.20.3,
--   Node 22), which is exactly what produces central_needs_source_records.
--   Columns were classified by DATA SHAPE, not by header text: the material
--   column is the one carrying the most distinct non-numeric strings; a
--   quantity column is any other column holding a number on a material row,
--   excluding a 1..n serial column and columns whose header context names a
--   total or a price. Measured:
--
--       57 workbooks, 71 sheets, 113950 source records (one per imported cell)
--       70 sheets with an identifiable material column
--       58 sheets carry TWO OR MORE quantity columns
--     3861 material rows carry TWO OR MORE non-zero quantity cells
--    25000 non-zero quantity cells sit on such rows
--       17 sheets repeat the SAME material text on more than one row (91 rows)
--     3061 source records share (target_entity, field_name) with another record
--          of the same import session (two columns under one header text)
--
--   An independent review of the same archive, recognising institution columns
--   by its own method, measured 55 sheets with two or more institution columns,
--   2603 material rows with two or more non-zero institution cells and 18961
--   such cells. The methods recognise columns differently, so the counts
--   differ; both establish the same shape.
--
--   What that proves, and what it does not:
--
--   1. ONE ROW -> ONE LINE IS FALSE FOR THIS CORPUS. A multi-institution sheet
--      puts one material on one row and each institution's quantity in its own
--      column, so one row legitimately yields several requirements for
--      DIFFERENT beneficiaries. There is therefore no row-level cardinality
--      rule anywhere in this migration.
--   2. THE INVARIANT LIVES AT CELL GRAIN: ONE SOURCE RECORD -> AT MOST ONE NEED
--      LINE. Each imported cell is exactly one source record, and
--      UNIQUE (source_record_id) guarantees one exact cell can never be
--      consumed twice. It is keyed on the record's id, not on
--      (target_entity, field_name): 3061 records share that pair with a
--      sibling, so the pair is not a cell identity.
--   3. MATERIAL IDENTITY STAYS ROW-SCOPED. A row is mapped to one canonical
--      item, (import_session_id, target_entity) -> central_item_id (M210), and
--      every cell of that row inherits it. Only QUANTITY lineage is cell-scoped.
--   4. N CELLS -> 1 LINE IS NORMAL TOO. The same material recurs on several
--      rows, and a line may consolidate cells from several import sessions of
--      its revision, so a need line holds N >= 1 links, revision-wide.
--   5. A HEADER IS EVIDENCE, NOT AN INSTITUTION. Nothing here proves which
--      beneficiary a column means; the beneficiary of every line is chosen by a
--      human and is never inferred from a header, sheet or file name.
--   6. NO WAREHOUSE DIMENSION IS ESTABLISHED BY THIS SOURCE. A keyword scan of
--      every column's header context (مخزن مخازن مستودع صيدلية شعبة موقع store
--      warehouse depot) matches in only 2 sheets, which does not make a
--      warehouse column. A warehouse-targeted requirement is permitted by owner
--      decision 1, so the warehouse-aware key below is a forward guarantee
--      rather than a fragmentation of today's data.
--   7. It does NOT prove that one institution needs the same canonical material
--      as two separate ANNUAL requirements. An annual requirement for a
--      material at an institution is one number; its cells are inputs to that
--      number, not competing answers to it.
--
--   Frozen cardinality, therefore:
--
--       source record (cell)  : need line      = at most 1
--       need line             : source records = N  (N >= 1, revision-wide)
--       imported row          : need lines     = M  (M >= 0)
--       need line per (revision, beneficiary, item, warehouse-scope) = 1
--
--   expressed as
--
--       UNIQUE (source_record_id)                             -- link table
--       UNIQUE NULLS NOT DISTINCT (plan_revision_id, beneficiary_organization_id,
--                                  central_item_id, target_warehouse_id)
--
--   `NULLS NOT DISTINCT` (PostgreSQL 15+; Production and both CI rigs run 17/18)
--   is load-bearing. With default NULLS DISTINCT semantics two institution-level
--   lines for the same material would BOTH be accepted, because NULL never
--   equals NULL — the accounting scope would silently double count. Measured on
--   17.10: with NULLS NOT DISTINCT the second NULL-warehouse row is rejected
--   with unique_violation, a warehouse-specific row for the same triple is
--   accepted, and `ON CONFLICT (…, target_warehouse_id)` still infers the key.
--
--   One further invariant cannot be written as a UNIQUE and is therefore
--   enforced by the deferred constraint trigger in section 2b: a triple is
--   EITHER institution-level (exactly one line, NULL warehouse) OR split across
--   explicit warehouses — never both at once, which would count the
--   institution-level total twice.
--
--   No source record is rewritten, merged or discarded to achieve any of this.
--
-- QUANTITY PROVENANCE (owner decision 3; independent review blockers 2 and 4)
--   `approved_quantity` is not a free-form number beside a row reference. Every
--   need line must name the exact source records the reviewer designated, and
--   each link carries the contribution that record makes:
--
--       source_values (central_needs_source_records, immutable)
--         -> optional normalization/override (central_needs_field_overrides,
--            pinned by applied_override_id when the reviewer relied on one; the
--            override must be this revision's override of this exact record)
--         -> designated_quantity            (the reviewer's decision, per record)
--         -> SUM(designated_quantity) = approved_quantity   (enforced)
--         -> operational need line
--
--   So the chain is provable in SQL, N -> 1 contributions are preserved
--   individually, and a line with NO lineage is impossible: at least one link is
--   required by the write RPC and re-asserted at COMMIT by the deferred
--   constraint trigger for every line a change touches. Links are ADDED only by
--   the write RPC and REMOVED only by the explicit, reasoned delete RPC (section
--   4) — never as a side effect of saving. The generic override/audit framework
--   is reused, never duplicated — nothing copies `source_values` or an
--   override's `final_value`.
--
--   Canonical material consistency is part of the same invariant: every linked
--   record's row must be dispositioned `mapped` to EXACTLY the need line's
--   `central_item_id` (`central_needs_record_mappings`). A source reviewed as
--   material A can never feed an operational line for material B. Because that
--   mapping stays mutable by design (M210: "a mapping is a correction, not
--   source evidence"), a later re-mapping is caught by a new review blocker
--   rather than by silently rewriting the approved line.
-- ===========================================================================

-- ----------------------------------------------------------------------------
-- 0. Preconditions. Fail closed rather than half-apply.
-- ----------------------------------------------------------------------------
DO $precondition$
BEGIN
  IF to_regclass('public.central_needs_plan_revisions') IS NULL
     OR to_regclass('public.central_needs_record_mappings') IS NULL
     OR to_regclass('public.central_needs_import_sessions') IS NULL
     OR to_regclass('public.central_needs_source_records') IS NULL
     OR to_regclass('public.central_needs_field_overrides') IS NULL THEN
    RAISE EXCEPTION '212_precondition_failed: M209/M210/M211 Central Needs surface is absent';
  END IF;

  -- The provenance FK below needs M210's composite key on source records.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_source_records'::regclass
       AND contype  = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (id, organization_id)'
  ) THEN
    RAISE EXCEPTION '212_precondition_failed: central_needs_source_records UNIQUE (id, organization_id) absent';
  END IF;

  -- NULLS NOT DISTINCT is PostgreSQL 15+. Production and both CI rigs are 17/18,
  -- but a silent downgrade would turn the scope key into a double-counting one.
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION '212_precondition_failed: PostgreSQL 15+ required for NULLS NOT DISTINCT (got %)',
      current_setting('server_version');
  END IF;

  IF to_regclass('public.central_needs_need_lines') IS NOT NULL THEN
    RAISE EXCEPTION '212_precondition_failed: central_needs_need_lines already exists';
  END IF;

  -- The role-class rule M211 applies to every Central Needs relation, reused
  -- here for the two new ones rather than re-derived.
  IF to_regprocedure('public._phoenix_central_needs_role_eligible_v1()') IS NULL THEN
    RAISE EXCEPTION '212_precondition_failed: M211 _phoenix_central_needs_role_eligible_v1() absent';
  END IF;

  -- The canonical unit vocabulary this migration mirrors must still be the one
  -- central_items enforces. If that list ever changes, this migration must be
  -- revisited rather than silently diverge into a second vocabulary.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_items'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) LIKE '%unit%'
       AND pg_get_constraintdef(oid) LIKE '%box%'
       AND pg_get_constraintdef(oid) LIKE '%sachet%'
  ) THEN
    RAISE EXCEPTION '212_precondition_failed: central_items unit vocabulary CHECK not found';
  END IF;
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. The canonical operational need line.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_need_lines (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_revision_id            uuid NOT NULL,
  -- The OWNING/authorizing central organization. Same meaning as everywhere
  -- else in Central Needs, so RLS and the guard behave identically here.
  organization_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- The institution whose annual requirement this line belongs to. A distinct
  -- dimension from organization_id above; never a substitute for it.
  beneficiary_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Optional routing context. NULL means the requirement is institution-level.
  -- Validated against the beneficiary's own warehouses by the write RPC and
  -- re-checked by the review blockers (no composite FK is available because
  -- `warehouses` carries no UNIQUE (id, organization_id), and this migration
  -- does not alter a core operational table to create one).
  target_warehouse_id         uuid REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  central_item_id             uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  -- No typmod: a scale would SILENTLY ROUND a higher-scale value (see header).
  approved_quantity           numeric NOT NULL,
  -- NULL exactly when unit_conversion_state = 'conversion_required'.
  approved_unit               text,
  unit_conversion_state       text NOT NULL DEFAULT 'canonical',
  -- Evidence only — the unit label as the source expressed it. Never authority.
  source_unit_text            text,
  -- v7.3 section 9: every manual change/link requires a reason.
  mapping_reason              text NOT NULL,
  mapped_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- The accounting scope, frozen from measured corpus evidence (see header).
  -- NULLS NOT DISTINCT is load-bearing: without it two institution-level lines
  -- for one material would both be accepted and the annual total would double
  -- count, because NULL never equals NULL under the default semantics.
  CONSTRAINT central_needs_need_lines_scope_key
    UNIQUE NULLS NOT DISTINCT
      (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id),
  -- Exposed so the link table can prove its parent's owning org declaratively,
  -- matching M209's composite-FK pattern.
  CONSTRAINT central_needs_need_lines_id_org_key UNIQUE (id, organization_id),

  CONSTRAINT central_needs_need_lines_quantity_chk
    CHECK (approved_quantity >= 0),
  -- `>= 0` does not exclude NaN (NaN compares greater than every number), and an
  -- unconstrained numeric accepts Infinity. Both are refused explicitly.
  CONSTRAINT central_needs_need_lines_quantity_finite_chk
    CHECK (approved_quantity <> 'NaN'::numeric AND approved_quantity < 'Infinity'::numeric),
  CONSTRAINT central_needs_need_lines_unit_vocab_chk
    CHECK (approved_unit IS NULL OR approved_unit IN
      ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other')),
  CONSTRAINT central_needs_need_lines_conversion_vocab_chk
    CHECK (unit_conversion_state IN ('canonical', 'conversion_required')),
  -- The two states are mutually exclusive and individually complete, so a NULL
  -- unit can never mean "unknown".
  CONSTRAINT central_needs_need_lines_conversion_pair_chk
    CHECK (
      (unit_conversion_state = 'canonical'            AND approved_unit IS NOT NULL)
      OR
      (unit_conversion_state = 'conversion_required'  AND approved_unit IS NULL)
    ),
  CONSTRAINT central_needs_need_lines_reason_chk
    CHECK (btrim(mapping_reason) <> ''),

  -- organization_id must be the revision's own owning org.
  CONSTRAINT central_needs_need_lines_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_need_lines_revision_idx
  ON public.central_needs_need_lines (plan_revision_id);
CREATE INDEX central_needs_need_lines_beneficiary_item_idx
  ON public.central_needs_need_lines (beneficiary_organization_id, central_item_id);
CREATE INDEX central_needs_need_lines_org_idx
  ON public.central_needs_need_lines (organization_id);
CREATE INDEX central_needs_need_lines_warehouse_idx
  ON public.central_needs_need_lines (target_warehouse_id)
  WHERE target_warehouse_id IS NOT NULL;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.central_needs_need_lines
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();

COMMENT ON TABLE public.central_needs_need_lines IS
  'CN-2B conformance (212): the canonical operational Annual Needs projection — one approved requirement per (plan revision, beneficiary organization, central item). Relational operational authority per v7.3 section 8.1; source evidence stays in central_needs_source_records. Created only by explicit human mapping; never backfilled, never inferred.';
COMMENT ON COLUMN public.central_needs_need_lines.organization_id IS
  'The OWNING/authorizing central organization — the same dimension every other Central Needs table authorizes on. Not the beneficiary.';
COMMENT ON COLUMN public.central_needs_need_lines.beneficiary_organization_id IS
  'The institution whose annual requirement this line belongs to. Human-authoritative: never inferred from workbook family, sheet name, header match, sheet index, filename or row proximity.';
COMMENT ON COLUMN public.central_needs_need_lines.target_warehouse_id IS
  'Optional routing context, valid only when the source is explicitly warehouse-specific. NULL means institution-level. Must belong to the beneficiary organization.';
COMMENT ON COLUMN public.central_needs_need_lines.approved_quantity IS
  'Exact unconstrained numeric — no scale, so no value is ever silently rounded; NaN and Infinity are refused by CHECK. Equals the SUM of its source records'' designated contributions. Zero is valid; blank is not zero (it is simply no line).';
COMMENT ON COLUMN public.central_needs_need_lines.approved_unit IS
  'Canonical unit from central_items'' controlled vocabulary, or NULL when unit_conversion_state = conversion_required. No second unit catalog exists.';
COMMENT ON COLUMN public.central_needs_need_lines.unit_conversion_state IS
  'canonical = the quantity is expressed in the canonical unit. conversion_required = the source unit could not be safely converted; the conversion is NOT guessed and the line blocks approval.';

ALTER TABLE public.central_needs_need_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_need_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_need_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_need_lines FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_need_lines FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_need_lines TO authenticated;

-- Read is gated on the OWNING organization, exactly as every other Central
-- Needs policy is. A beneficiary institution does NOT gain read access to the
-- central plan through being named here (v7.3 section 1).
CREATE POLICY central_needs_need_lines_select_authorized
  ON public.central_needs_need_lines FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

-- M211's role-class rule, applied to this relation exactly as M211 applied it
-- to every Central Needs relation that existed then: a RESTRICTIVE policy, so an
-- ineligible role reads zero rows whatever capability it was granted. The read
-- RPC in section 4c is SECURITY INVOKER, so this policy governs it too.
CREATE POLICY central_needs_need_lines_role_eligible_restrictive
  ON public.central_needs_need_lines AS RESTRICTIVE FOR ALL TO authenticated
  USING (public._phoenix_central_needs_role_eligible_v1())
  WITH CHECK (public._phoenix_central_needs_role_eligible_v1());

-- ----------------------------------------------------------------------------
-- 2. The auditable cell-level quantity provenance: N source records -> 1 line.
-- ----------------------------------------------------------------------------
CREATE TABLE public.central_needs_need_line_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_line_id        uuid NOT NULL,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- The EXACT immutable source record (one imported cell: target_entity +
  -- field_name + its raw source_values) the reviewer designated. Record-level,
  -- not row-level: 58 of the corpus's 71 sheets carry two or more quantity
  -- columns per row (see header), so a row reference alone cannot say WHICH
  -- value became the approved quantity, nor for which beneficiary.
  source_record_id    uuid NOT NULL,
  -- The contribution this record makes to the line's approved quantity. This is
  -- the reviewer's DECISION, not a copy of the evidence: the raw value stays in
  -- central_needs_source_records and any normalization stays in
  -- central_needs_field_overrides. Unconstrained numeric for the same
  -- no-silent-rounding reason as approved_quantity.
  designated_quantity numeric NOT NULL,
  -- Pins the override the reviewer relied on, when one applies. NULL means the
  -- designation came from the record's own raw value.
  applied_override_id uuid REFERENCES public.central_needs_field_overrides(id) ON DELETE RESTRICT,
  linked_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  linked_at           timestamptz NOT NULL DEFAULT now(),

  -- ONE SOURCE RECORD (one imported cell) contributes to AT MOST ONE need line —
  -- the same "belongs to at most one" discipline v7.3 section 4 requires of
  -- allocation lineage, and the structural proof that an exact cell can never
  -- be consumed twice. It is deliberately the only cardinality rule at this
  -- grain: one ROW may feed several lines, because a multi-institution row
  -- carries a distinct cell per institution (see PROVEN CARDINALITY).
  CONSTRAINT central_needs_need_line_sources_record_key
    UNIQUE (source_record_id),
  CONSTRAINT central_needs_need_line_sources_quantity_chk
    CHECK (designated_quantity >= 0),
  CONSTRAINT central_needs_need_line_sources_quantity_finite_chk
    CHECK (designated_quantity <> 'NaN'::numeric AND designated_quantity < 'Infinity'::numeric),
  CONSTRAINT central_needs_need_line_sources_line_org_fk
    FOREIGN KEY (need_line_id, organization_id)
    REFERENCES public.central_needs_need_lines (id, organization_id)
    ON DELETE RESTRICT,
  -- The record must belong to the same organization this link claims. M210
  -- exposed UNIQUE (id, organization_id) on source records for exactly this.
  CONSTRAINT central_needs_need_line_sources_record_org_fk
    FOREIGN KEY (source_record_id, organization_id)
    REFERENCES public.central_needs_source_records (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX central_needs_need_line_sources_line_idx
  ON public.central_needs_need_line_sources (need_line_id);
CREATE INDEX central_needs_need_line_sources_override_idx
  ON public.central_needs_need_line_sources (applied_override_id)
  WHERE applied_override_id IS NOT NULL;

COMMENT ON TABLE public.central_needs_need_line_sources IS
  'CN-2B conformance (212): the auditable quantity-provenance relation — which immutable source records a human designated for one canonical need line, and what each contributes. SUM(designated_quantity) equals the line''s approved_quantity, enforced; at least one link is mandatory, so an orphan need line cannot exist. One source record feeds at most one line (UNIQUE source_record_id); one row may feed several. Links are added only by phoenix_central_needs_set_need_line and removed only by the explicit, reasoned phoenix_central_needs_delete_need_line; source evidence is never rewritten to record a consolidation.';
COMMENT ON COLUMN public.central_needs_need_line_sources.designated_quantity IS
  'The reviewer''s designated contribution from this source record. Not a copy of the raw value: evidence stays in central_needs_source_records, normalization in central_needs_field_overrides.';
COMMENT ON COLUMN public.central_needs_need_line_sources.applied_override_id IS
  'The field override the reviewer relied on for this record, when one applies. Validated to belong to the same revision and the same (target_entity, field_name) as the record.';

ALTER TABLE public.central_needs_need_line_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_need_line_sources FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_need_line_sources FROM PUBLIC;
REVOKE ALL ON TABLE public.central_needs_need_line_sources FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_need_line_sources FROM authenticated;
GRANT SELECT ON TABLE public.central_needs_need_line_sources TO authenticated;

CREATE POLICY central_needs_need_line_sources_select_authorized
  ON public.central_needs_need_line_sources FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));

CREATE POLICY central_needs_need_line_sources_role_eligible_restrictive
  ON public.central_needs_need_line_sources AS RESTRICTIVE FOR ALL TO authenticated
  USING (public._phoenix_central_needs_role_eligible_v1())
  WITH CHECK (public._phoenix_central_needs_role_eligible_v1());

-- ----------------------------------------------------------------------------
-- 2b. The invariants no UNIQUE or CHECK can express — asserted at COMMIT.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger, so the write RPCs can
-- legitimately insert a line and its links in any order inside one transaction
-- and still be refused if the result violates any of:
--
--   (1) LINEAGE IS MANDATORY        — at least one source link per need line.
--                                     An orphan operational line is impossible,
--                                     whatever write path is used, now or later.
--   (2) QUANTITY PROVENANCE ADDS UP — SUM(designated_quantity) = approved_quantity.
--   (3) MATERIAL CONSISTENCY        — every linked record's row is dispositioned
--                                     `mapped` to EXACTLY this line's item.
--   (4) SCOPE EXCLUSIVITY           — a (revision, beneficiary, item) triple is
--                                     either institution-level or warehouse-split,
--                                     never both, so the annual total is unambiguous.
--
-- There is deliberately NO row-level cardinality rule here. One imported ROW
-- legitimately feeds SEVERAL lines when its cells carry quantities for
-- different institutions (see PROVEN CARDINALITY in the header). The rule that
-- one exact imported CELL can never be consumed twice is structural instead:
-- UNIQUE (source_record_id) on the link table.
--
-- EVERY AFFECTED LINE IS ASSERTED, not just the row's NEW side. A link UPDATE
-- that re-points need_line_id changes TWO lines — the one it joins and the one
-- it leaves — and asserting only the joined line would let the last link of a
-- line move away and leave that line orphaned at COMMIT.
--
-- This is the SERVER boundary, not a UI courtesy: it holds even against a
-- future RPC, a migration, or a privileged session that forgets a rule.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line_ids uuid[];
  v_line_id  uuid;
  v_line     public.central_needs_need_lines%ROWTYPE;
  v_links    bigint;
  v_sum      numeric;
  v_bad      record;
BEGIN
  -- DELETE matters as much as INSERT: deleting the LAST link of a line that
  -- still exists must be refused.
  --
  -- Written as nested IF branches, not one CASE expression: plpgsql resolves a
  -- record field against the ROW TYPE IT ACTUALLY HAS, so mentioning
  -- OLD.need_line_id in an expression that also runs for
  -- central_needs_need_lines fails with "record old has no field need_line_id".
  -- One branch, one row type.
  IF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    v_line_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    v_line_ids := ARRAY[OLD.need_line_id];
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.need_line_id IS DISTINCT FROM NEW.need_line_id THEN
      v_line_ids := ARRAY[NEW.need_line_id, OLD.need_line_id];
    ELSE
      v_line_ids := ARRAY[NEW.need_line_id];
    END IF;
  ELSE
    v_line_ids := ARRAY[NEW.need_line_id];
  END IF;

  FOREACH v_line_id IN ARRAY v_line_ids
  LOOP
    SELECT * INTO v_line FROM public.central_needs_need_lines WHERE id = v_line_id;
    IF NOT FOUND THEN
      -- The line itself was removed later in the same transaction (the
      -- explicit delete RPC removes links first, then the line). Nothing is
      -- left to assert for it.
      CONTINUE;
    END IF;

    -- (1) and (2)
    SELECT count(*), coalesce(sum(designated_quantity), 0)
      INTO v_links, v_sum
      FROM public.central_needs_need_line_sources
     WHERE need_line_id = v_line.id;

    IF v_links = 0 THEN
      RAISE EXCEPTION 'need_line_requires_source_lineage' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s', v_line.id),
        HINT = 'Every operational need line must name at least one immutable source record.';
    END IF;

    IF v_sum <> v_line.approved_quantity THEN
      RAISE EXCEPTION 'need_line_quantity_provenance_mismatch' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s approved=%s designated_sum=%s',
                        v_line.id, v_line.approved_quantity, v_sum);
    END IF;

    -- (3) every linked record's row must be mapped to THIS line's canonical item.
    SELECT r.target_entity, m.central_item_id, m.decision
      INTO v_bad
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      LEFT JOIN public.central_needs_record_mappings m
             ON m.import_session_id = r.import_session_id
            AND m.target_entity     = r.target_entity
     WHERE ls.need_line_id = v_line.id
       AND (m.id IS NULL
            OR m.decision <> 'mapped'
            OR m.central_item_id IS DISTINCT FROM v_line.central_item_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'need_line_material_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s item=%s source_entity=%s mapped_item=%s decision=%s',
                        v_line.id, v_line.central_item_id, v_bad.target_entity,
                        coalesce(v_bad.central_item_id::text, '(none)'),
                        coalesce(v_bad.decision, '(none)')),
        HINT = 'Change the canonical mapping through the mapping workflow first; a source reviewed as one material cannot feed a line for another.';
    END IF;

    -- (4) institution-level and warehouse-split cannot coexist for one triple.
    IF EXISTS (
      SELECT 1
        FROM public.central_needs_need_lines a
        JOIN public.central_needs_need_lines b
          ON b.plan_revision_id            = a.plan_revision_id
         AND b.beneficiary_organization_id = a.beneficiary_organization_id
         AND b.central_item_id             = a.central_item_id
       WHERE a.plan_revision_id            = v_line.plan_revision_id
         AND a.beneficiary_organization_id = v_line.beneficiary_organization_id
         AND a.central_item_id             = v_line.central_item_id
         AND a.target_warehouse_id IS NULL
         AND b.target_warehouse_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'need_line_scope_mixes_institution_and_warehouse' USING ERRCODE = '23514',
        DETAIL = format('revision=%s beneficiary=%s item=%s',
                        v_line.plan_revision_id, v_line.beneficiary_organization_id,
                        v_line.central_item_id),
        HINT = 'An annual requirement is either institution-level or split by warehouse, never both.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1() IS
  'CN-2B conformance (212) internal: the deferred assertion that every need line a row change touched — both lines when a link is re-pointed — keeps mandatory source lineage, a designated-quantity sum equal to its approved quantity, canonical material agreement with every linked row''s mapping, and no institution-level/warehouse-split mixture. Runs at COMMIT, so it binds every write path rather than one RPC. No row-level cardinality: one row may feed several lines; one CELL may feed at most one (UNIQUE source_record_id).';

CREATE CONSTRAINT TRIGGER assert_need_line_integrity
  AFTER INSERT OR UPDATE ON public.central_needs_need_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1();

CREATE CONSTRAINT TRIGGER assert_need_line_integrity
  AFTER INSERT OR UPDATE OR DELETE ON public.central_needs_need_line_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1();

-- ----------------------------------------------------------------------------
-- 3. Beneficiary eligibility — reuse, do not invent.
--
-- There is no central->institution allow-list relation in this schema; 068's
-- transfer requests validate a destination through warehouse ownership, not a
-- membership table. So eligibility is the narrowest established fact: the
-- beneficiary must be a live care_institution organization. This grants NO
-- cross-org privilege — only the owning org can read its own plan's lines.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(
  p_beneficiary_organization_id uuid,
  p_target_warehouse_id         uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind      text;
  v_status    text;
  v_wh_org    uuid;
  v_wh_status text;
BEGIN
  IF p_beneficiary_organization_id IS NULL THEN
    RAISE EXCEPTION 'beneficiary_organization_required' USING ERRCODE = '23514';
  END IF;

  SELECT organization_kind, status INTO v_kind, v_status
    FROM public.organizations
   WHERE id = p_beneficiary_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'beneficiary_organization_not_found' USING ERRCODE = '23503';
  END IF;

  IF v_kind IS DISTINCT FROM 'care_institution' THEN
    RAISE EXCEPTION 'beneficiary_must_be_care_institution' USING ERRCODE = '23514',
      DETAIL = format('organization_kind=%s', v_kind);
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'beneficiary_organization_not_active' USING ERRCODE = '23514',
      DETAIL = format('status=%s', v_status);
  END IF;

  IF p_target_warehouse_id IS NOT NULL THEN
    SELECT organization_id, status INTO v_wh_org, v_wh_status
      FROM public.warehouses
     WHERE id = p_target_warehouse_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_warehouse_not_found' USING ERRCODE = '23503';
    END IF;

    IF v_wh_org IS DISTINCT FROM p_beneficiary_organization_id THEN
      RAISE EXCEPTION 'target_warehouse_not_owned_by_beneficiary' USING ERRCODE = '23514';
    END IF;

    -- Ownership is not lifecycle. `warehouses.status` is ('active', 'inactive',
    -- 'archived') (001), and a warehouse the beneficiary still owns can be
    -- archived or inactivated. A NEW routing to it is refused here; a warehouse
    -- that stops being active AFTER a line was routed to it is caught by the
    -- `need_line_target_warehouse_not_active` review blocker instead, because
    -- this STABLE check cannot lock the warehouse row against a later change.
    IF v_wh_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'target_warehouse_not_active' USING ERRCODE = '23514',
        DETAIL = format('warehouse=%s status=%s', p_target_warehouse_id, v_wh_status),
        HINT = 'Route a requirement only to an active warehouse of the beneficiary.';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid) IS
  'CN-2B conformance (212) internal: the single definition of beneficiary eligibility — a live care_institution, plus, when a target warehouse is named, that the warehouse belongs to the beneficiary AND is currently active. Server-side only; never trusts a UI-validated value.';

-- ----------------------------------------------------------------------------
-- 4. The canonical write and read primitives.
--
--   4a  phoenix_central_needs_set_need_line     create a line, or ADD provenance
--                                               to it. It never removes a link.
--   4b  phoenix_central_needs_delete_need_line  the explicit, reasoned, audited
--                                               correction path.
--   4c  phoenix_central_needs_list_need_lines   the exact-decimal read.
--
-- WHY SAVING NEVER REMOVES PROVENANCE (independent review Q1)
--   Provenance is REVISION-wide: one need line may consolidate cells from
--   several import sessions of its revision. A client, however, looks at one
--   session at a time. An earlier revision of 4a replaced a line's links with
--   whatever the caller submitted, so saving a later session silently discarded
--   every link from an earlier one. Removing provenance is now possible ONLY
--   through 4b, with a mandatory reason — never as a side effect of saving.
--
-- STALE CLIENTS (optimistic concurrency, without a new column)
--   4a and 4b both take `p_expected_source_record_ids`: the exact set of source
--   records the caller believes the line holds right now (an empty array when
--   it expects no line yet). `_phoenix_central_needs_load_revision_v1` locks the
--   revision row FOR UPDATE, so every need-line write of one revision queues
--   there and the comparison reads the latest committed provenance. A mismatch
--   refuses the whole call with `need_line_lineage_stale`; nothing is written.
--   A stale view that differs in any other way that matters to provenance is
--   refused too: 4a will not change an existing line's unit attributes (an
--   existing designation is a quantity IN that unit), a changed designated
--   quantity makes the provenance sum disagree, and 4b addresses the line by
--   id, which a delete-and-recreate replaces.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_need_line(
  p_plan_revision_id            uuid,
  p_beneficiary_organization_id uuid,
  p_central_item_id             uuid,
  -- The line's approved quantity AFTER this call: the contributions it already
  -- holds plus the ones submitted here. Re-derived server-side.
  p_approved_quantity           numeric,
  p_mapping_reason              text,
  -- The designated quantity provenance to ADD. REQUIRED and deliberately given
  -- NO default: a caller that omits it gets "function does not exist" rather
  -- than an accidentally unsourced line. Shape, per element:
  --   { "sourceRecordId": uuid, "designatedQuantity": numeric-as-string,
  --     "appliedOverrideId": uuid | null }
  p_quantity_sources            jsonb,
  -- The source records the caller believes this scope's line holds now; an
  -- empty array when it expects no line. REQUIRED, no default (see above).
  p_expected_source_record_ids  uuid[],
  p_approved_unit               text    DEFAULT NULL,
  p_unit_conversion_state       text    DEFAULT 'canonical',
  p_target_warehouse_id         uuid    DEFAULT NULL,
  p_source_unit_text            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_revision     public.central_needs_plan_revisions%ROWTYPE;
  v_reason       text := NULLIF(btrim(p_mapping_reason), '');
  v_state        text := NULLIF(btrim(p_unit_conversion_state), '');
  v_unit         text := NULLIF(btrim(p_approved_unit), '');
  v_source_unit  text := NULLIF(btrim(coalesce(p_source_unit_text, '')), '');
  v_line         public.central_needs_need_lines%ROWTYPE;
  v_created      boolean;
  v_existing_ids uuid[];
  v_existing_sum numeric;
  v_expected_ids uuid[];
  v_added_count  integer := 0;
  v_added_sum    numeric := 0;
  v_record       public.central_needs_source_records%ROWTYPE;
  v_src          jsonb;
  v_record_id    uuid;
  v_qty          numeric;
  v_override     uuid;
  v_holder       uuid;
  v_constraint   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- Locks the revision row FOR UPDATE: every need-line write of this revision
  -- is serialized from here on.
  v_revision := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  -- Authorization on the OWNING org, through the canonical helper. Identical to
  -- every other Central Needs write.
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);

  -- Only a still-editable revision may have its mappings changed. Approved
  -- history is never mutated in place (v7.3 section 11.2).
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status);

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'mapping_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.central_items WHERE id = p_central_item_id) THEN
    RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = '23503';
  END IF;
  IF p_approved_quantity IS NULL THEN
    RAISE EXCEPTION 'approved_quantity_required' USING ERRCODE = '23514';
  END IF;
  -- NaN first: it compares greater than every number, so the sign test below
  -- would wave it through.
  IF p_approved_quantity = 'NaN'::numeric OR p_approved_quantity >= 'Infinity'::numeric THEN
    RAISE EXCEPTION 'approved_quantity_must_be_finite' USING ERRCODE = '23514';
  END IF;
  IF p_approved_quantity < 0 THEN
    RAISE EXCEPTION 'approved_quantity_must_not_be_negative' USING ERRCODE = '23514';
  END IF;
  IF v_state IS NULL OR v_state NOT IN ('canonical', 'conversion_required') THEN
    RAISE EXCEPTION 'unit_conversion_state_invalid' USING ERRCODE = '23514';
  END IF;
  IF v_state = 'canonical' AND v_unit IS NULL THEN
    RAISE EXCEPTION 'canonical_unit_required' USING ERRCODE = '23514';
  END IF;
  IF v_state = 'conversion_required' AND v_unit IS NOT NULL THEN
    RAISE EXCEPTION 'conversion_required_must_not_carry_unit' USING ERRCODE = '23514';
  END IF;
  -- array_position finds a NULL element too (IS NOT DISTINCT FROM semantics).
  IF p_expected_source_record_ids IS NULL
     OR array_position(p_expected_source_record_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'expected_source_record_ids_required' USING ERRCODE = '23514',
      HINT = 'State the source records this line holds as you last loaded it — an empty array when you expect no line yet.';
  END IF;

  IF p_quantity_sources IS NULL OR jsonb_typeof(p_quantity_sources) <> 'array' THEN
    RAISE EXCEPTION 'quantity_sources_must_be_array' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_quantity_sources) = 0 THEN
    RAISE EXCEPTION 'need_line_requires_source_lineage' USING ERRCODE = '23514',
      HINT = 'Designate at least one imported source record as the origin of this approved quantity.';
  END IF;

  PERFORM public._phoenix_central_needs_assert_beneficiary_v1(
    p_beneficiary_organization_id, p_target_warehouse_id);

  -- The line this accounting scope already has, if any, and what it holds.
  SELECT * INTO v_line
    FROM public.central_needs_need_lines
   WHERE plan_revision_id            = v_revision.id
     AND beneficiary_organization_id = p_beneficiary_organization_id
     AND central_item_id             = p_central_item_id
     AND target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   FOR UPDATE;
  v_created := NOT FOUND;

  SELECT coalesce(array_agg(ls.source_record_id ORDER BY ls.source_record_id), ARRAY[]::uuid[]),
         coalesce(sum(ls.designated_quantity), 0)
    INTO v_existing_ids, v_existing_sum
    FROM public.central_needs_need_line_sources ls
   WHERE ls.need_line_id = v_line.id;

  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), ARRAY[]::uuid[])
    INTO v_expected_ids
    FROM unnest(p_expected_source_record_ids) AS e;

  IF v_expected_ids IS DISTINCT FROM v_existing_ids THEN
    RAISE EXCEPTION 'need_line_lineage_stale' USING ERRCODE = '23514',
      DETAIL = format('need_line=%s expected_links=%s current_links=%s',
                      coalesce(v_line.id::text, '(none)'),
                      cardinality(v_expected_ids), cardinality(v_existing_ids)),
      HINT = 'This requirement''s provenance changed since it was loaded. Reload it and decide again; nothing was written.';
  END IF;

  IF v_created THEN
    BEGIN
      INSERT INTO public.central_needs_need_lines (
        plan_revision_id, organization_id, beneficiary_organization_id,
        target_warehouse_id, central_item_id, approved_quantity, approved_unit,
        unit_conversion_state, source_unit_text, mapping_reason, mapped_by
      ) VALUES (
        v_revision.id, v_revision.organization_id, p_beneficiary_organization_id,
        p_target_warehouse_id, p_central_item_id, p_approved_quantity, v_unit,
        v_state, v_source_unit, v_reason, v_actor
      )
      RETURNING * INTO v_line;
    EXCEPTION WHEN unique_violation THEN
      -- Expected only when a concurrent transaction created this scope after
      -- this one's snapshot was taken. Translated to a stable domain error;
      -- any OTHER unique violation is re-raised untouched.
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'central_needs_need_lines_scope_key' THEN
        RAISE EXCEPTION 'need_line_scope_conflict' USING ERRCODE = '23514',
          HINT = 'This requirement was created concurrently. Reload it and add to it instead.';
      END IF;
      RAISE;
    END;
  ELSIF v_line.unit_conversion_state IS DISTINCT FROM v_state
     OR v_line.approved_unit IS DISTINCT FROM v_unit
     OR (v_source_unit IS NOT NULL AND v_source_unit IS DISTINCT FROM v_line.source_unit_text) THEN
    RAISE EXCEPTION 'need_line_attributes_conflict' USING ERRCODE = '23514',
      DETAIL = format('need_line=%s unit=%s state=%s', v_line.id,
                      coalesce(v_line.approved_unit, '(none)'), v_line.unit_conversion_state),
      HINT = 'Provenance added to an existing line is a quantity in that line''s unit. To change the unit, delete the line with a reason and map it again.';
  END IF;

  FOR v_src IN SELECT e FROM jsonb_array_elements(p_quantity_sources) AS e
  LOOP
    v_record_id := NULLIF(btrim(coalesce(v_src->>'sourceRecordId', '')), '')::uuid;
    v_override  := NULLIF(btrim(coalesce(v_src->>'appliedOverrideId', '')), '')::uuid;
    IF v_record_id IS NULL THEN
      RAISE EXCEPTION 'source_link_requires_source_record_id' USING ERRCODE = '23514';
    END IF;
    IF (v_src->'designatedQuantity') IS NULL OR jsonb_typeof(v_src->'designatedQuantity') = 'null' THEN
      RAISE EXCEPTION 'source_link_requires_designated_quantity' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;
    -- Accepts a JSON string or a JSON number; a string keeps an exact decimal
    -- out of any float representation on the way in.
    BEGIN
      v_qty := (v_src->>'designatedQuantity')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'designated_quantity_not_numeric' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s value=%s', v_record_id, v_src->>'designatedQuantity');
    END;
    IF v_qty = 'NaN'::numeric OR v_qty >= 'Infinity'::numeric THEN
      RAISE EXCEPTION 'designated_quantity_must_be_finite' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;
    IF v_qty < 0 THEN
      RAISE EXCEPTION 'designated_quantity_must_not_be_negative' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;

    SELECT * INTO v_record
      FROM public.central_needs_source_records WHERE id = v_record_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source_record_not_found' USING ERRCODE = '23503',
        DETAIL = format('source_record=%s', v_record_id);
    END IF;

    -- The record's session must belong to THIS revision, so a link can never
    -- import evidence from another plan.
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_import_sessions
       WHERE id = v_record.import_session_id AND plan_revision_id = v_revision.id
    ) THEN
      RAISE EXCEPTION 'source_link_session_not_in_revision' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s session=%s', v_record_id, v_record.import_session_id);
    END IF;

    -- Only a row a human dispositioned as 'mapped' may feed an operational
    -- line, and it must be mapped to EXACTLY this line's canonical material.
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_record_mappings
       WHERE import_session_id = v_record.import_session_id
         AND target_entity     = v_record.target_entity
         AND decision          = 'mapped'
    ) THEN
      RAISE EXCEPTION 'source_link_requires_mapped_disposition' USING ERRCODE = '23514',
        DETAIL = format('session=%s target_entity=%s',
                        v_record.import_session_id, v_record.target_entity);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.central_needs_record_mappings
       WHERE import_session_id = v_record.import_session_id
         AND target_entity     = v_record.target_entity
         AND decision          = 'mapped'
         AND central_item_id   = p_central_item_id
    ) THEN
      RAISE EXCEPTION 'source_link_material_mismatch' USING ERRCODE = '23514',
        DETAIL = format('session=%s target_entity=%s need_line_item=%s',
                        v_record.import_session_id, v_record.target_entity, p_central_item_id),
        HINT = 'A source reviewed as one material cannot feed an operational line for another. Change the canonical mapping through the mapping workflow first.';
    END IF;

    -- An override, when named, must be THIS revision's override of THIS exact
    -- source record. M210 made central_needs_field_overrides.source_record_id
    -- NOT NULL precisely so an override has one unambiguous record, so the check
    -- is an identity comparison rather than an (entity, field) match.
    IF v_override IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.central_needs_field_overrides o
       WHERE o.id               = v_override
         AND o.plan_revision_id = v_revision.id
         AND o.source_record_id = v_record_id
    ) THEN
      RAISE EXCEPTION 'applied_override_does_not_match_source_record' USING ERRCODE = '23514',
        DETAIL = format('override=%s source_record=%s', v_override, v_record_id);
    END IF;

    -- ONE CELL -> AT MOST ONE LINE. Asked explicitly first, so the refusal is
    -- a stable domain error naming the line that holds the cell rather than a
    -- raw unique_violation. This also refuses the same cell twice in one call.
    SELECT ls.need_line_id INTO v_holder
      FROM public.central_needs_need_line_sources ls
     WHERE ls.source_record_id = v_record_id;
    IF FOUND THEN
      RAISE EXCEPTION 'source_record_already_linked' USING ERRCODE = '23514',
        DETAIL = format('source_record=%s need_line=%s', v_record_id, v_holder),
        HINT = 'One imported cell can feed at most one need line. If it was designated wrongly, delete the line that holds it with a reason first.';
    END IF;

    BEGIN
      INSERT INTO public.central_needs_need_line_sources (
        need_line_id, organization_id, source_record_id, designated_quantity,
        applied_override_id, linked_by
      ) VALUES (
        v_line.id, v_revision.organization_id, v_record_id, v_qty, v_override, v_actor
      );
    EXCEPTION WHEN unique_violation THEN
      -- Expected only when a concurrent transaction linked this cell after this
      -- one's snapshot was taken. Translated, never leaked; any OTHER unique
      -- violation is re-raised untouched.
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'central_needs_need_line_sources_record_key' THEN
        RAISE EXCEPTION 'source_record_already_linked' USING ERRCODE = '23514',
          DETAIL = format('source_record=%s', v_record_id),
          HINT = 'One imported cell can feed at most one need line. Reload and decide again.';
      END IF;
      RAISE;
    END;
    v_added_count := v_added_count + 1;
    v_added_sum   := v_added_sum + v_qty;
  END LOOP;

  -- The approved quantity IS its provenance, summed: everything the line
  -- already held plus what was added here. Stated by the caller and re-derived
  -- here, so a total can never drift from the records behind it.
  IF v_existing_sum + v_added_sum <> p_approved_quantity THEN
    RAISE EXCEPTION 'need_line_quantity_provenance_mismatch' USING ERRCODE = '23514',
      DETAIL = format('approved=%s existing_sum=%s added_sum=%s',
                      p_approved_quantity, v_existing_sum, v_added_sum),
      HINT = 'The approved quantity must equal the sum of every designated source contribution the line holds, including the ones it already had.';
  END IF;

  IF NOT v_created THEN
    UPDATE public.central_needs_need_lines
       SET approved_quantity = p_approved_quantity,
           mapping_reason    = v_reason,
           mapped_by         = v_actor
     WHERE id = v_line.id;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id,
    entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.need_line.set', 'central_needs_need_line', v_line.id,
    NULL,
    jsonb_build_object(
      'operation', CASE WHEN v_created THEN 'created' ELSE 'extended' END,
      'plan_revision_id', v_revision.id,
      'beneficiary_organization_id', p_beneficiary_organization_id,
      'central_item_id', p_central_item_id,
      'target_warehouse_id', p_target_warehouse_id,
      -- ::text so an exact decimal survives in the audit payload too: jsonb
      -- numbers are fine in PostgreSQL, but every downstream JSON reader is a
      -- float away from losing a digit.
      'approved_quantity', p_approved_quantity::text,
      'previous_approved_quantity',
        CASE WHEN v_created THEN NULL ELSE v_line.approved_quantity::text END,
      'approved_unit', v_unit,
      'unit_conversion_state', v_state,
      'source_link_count', cardinality(v_existing_ids) + v_added_count,
      'added_link_count', v_added_count,
      'designated_sum', (v_existing_sum + v_added_sum)::text,
      'previous_source_record_ids', to_jsonb(v_existing_ids),
      'quantity_sources', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'source_record_id', ls.source_record_id,
                 'designated_quantity', ls.designated_quantity::text,
                 'applied_override_id', ls.applied_override_id)
               ORDER BY ls.source_record_id), '[]'::jsonb)
          FROM public.central_needs_need_line_sources ls
         WHERE ls.need_line_id = v_line.id),
      'mapping_reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'need_line_id', v_line.id,
    'created', v_created,
    'source_link_count', cardinality(v_existing_ids) + v_added_count,
    'added_link_count', v_added_count,
    'approved_quantity', p_approved_quantity::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_set_need_line(
  uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) IS
  'CN-2B conformance (212): creates an operational Annual Needs line or ADDS designated provenance to the existing line of the same accounting scope. Never removes a link. Validates authorization, revision editability, owning org, beneficiary eligibility, warehouse ownership AND active status, material, unit vocabulary, conversion state, quantity finiteness and sign, MANDATORY source-record provenance (each record mapped to this exact central item, each cell linked to at most one line, every contribution summing to the approved quantity), the caller''s expected lineage (stale views are refused) and the reason — all server-side. Draft revisions only. Fully audited. Never trusts a UI-validated value.';

-- ----------------------------------------------------------------------------
-- 4b. The explicit correction path (independent review Q3).
--
-- A draft need line must never become irrecoverably stuck: a wrong
-- beneficiary, a wrong target warehouse, a wrong source designation, a unit
-- that needs changing, or a row later re-mapped to another material. Each is
-- recovered the same way — delete the line with a reason, then map it again
-- through 4a — with no manual SQL and no weakened constraint.
--
-- The owning organization is DERIVED from the line's own revision; the caller
-- names only the line. Links are deleted first, then the line, in one
-- transaction; the deferred integrity trigger then finds no line left to
-- assert. Source evidence and field overrides are never touched, and an
-- approved (or any non-draft) revision refuses through the canonical assertion.
-- The audit row carries the deleted line's full identity, scope, quantities
-- and every deleted link, so the removed provenance stays reconstructable.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_delete_need_line(
  p_need_line_id               uuid,
  p_reason                     text,
  -- The source records the caller believes the line holds (see section 4).
  p_expected_source_record_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_reason       text := NULLIF(btrim(p_reason), '');
  v_revision_id  uuid;
  v_revision     public.central_needs_plan_revisions%ROWTYPE;
  v_line         public.central_needs_need_lines%ROWTYPE;
  v_existing_ids uuid[];
  v_expected_ids uuid[];
  v_links        jsonb;
  v_deleted      integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_need_line_id IS NULL THEN
    RAISE EXCEPTION 'need_line_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT n.plan_revision_id INTO v_revision_id
    FROM public.central_needs_need_lines n
   WHERE n.id = p_need_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'need_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- load -> authorize -> assert-editable, exactly as every Central Needs RPC.
  -- The revision lock serializes this with every other need-line write.
  v_revision := public._phoenix_central_needs_load_revision_v1(v_revision_id);
  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit');
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status);

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'need_line_deletion_reason_required' USING ERRCODE = '23514',
      HINT = 'Removing an operational requirement is a correction and must say why.';
  END IF;
  IF p_expected_source_record_ids IS NULL
     OR array_position(p_expected_source_record_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'expected_source_record_ids_required' USING ERRCODE = '23514',
      HINT = 'State the source records this line holds as you last loaded it.';
  END IF;

  -- Re-read under the revision lock: a concurrent delete may have won.
  SELECT * INTO v_line
    FROM public.central_needs_need_lines
   WHERE id = p_need_line_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'need_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(array_agg(ls.source_record_id ORDER BY ls.source_record_id), ARRAY[]::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object(
                    'source_record_id', ls.source_record_id,
                    'designated_quantity', ls.designated_quantity::text,
                    'applied_override_id', ls.applied_override_id,
                    'linked_by', ls.linked_by,
                    'linked_at', ls.linked_at)
                  ORDER BY ls.source_record_id), '[]'::jsonb)
    INTO v_existing_ids, v_links
    FROM public.central_needs_need_line_sources ls
   WHERE ls.need_line_id = v_line.id;

  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), ARRAY[]::uuid[])
    INTO v_expected_ids
    FROM unnest(p_expected_source_record_ids) AS e;

  IF v_expected_ids IS DISTINCT FROM v_existing_ids THEN
    RAISE EXCEPTION 'need_line_lineage_stale' USING ERRCODE = '23514',
      DETAIL = format('need_line=%s expected_links=%s current_links=%s',
                      v_line.id, cardinality(v_expected_ids), cardinality(v_existing_ids)),
      HINT = 'This requirement''s provenance changed since it was loaded. Reload it and decide again; nothing was deleted.';
  END IF;

  -- Links first (their FK to the line is ON DELETE RESTRICT), then the line.
  DELETE FROM public.central_needs_need_line_sources WHERE need_line_id = v_line.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM public.central_needs_need_lines WHERE id = v_line.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id,
    entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.need_line.delete', 'central_needs_need_line', v_line.id,
    NULL,
    jsonb_build_object(
      'plan_revision_id', v_line.plan_revision_id,
      'organization_id', v_line.organization_id,
      'beneficiary_organization_id', v_line.beneficiary_organization_id,
      'central_item_id', v_line.central_item_id,
      'target_warehouse_id', v_line.target_warehouse_id,
      'approved_quantity', v_line.approved_quantity::text,
      'approved_unit', v_line.approved_unit,
      'unit_conversion_state', v_line.unit_conversion_state,
      'source_unit_text', v_line.source_unit_text,
      'mapping_reason', v_line.mapping_reason,
      'mapped_by', v_line.mapped_by,
      'deletion_reason', v_reason,
      'deleted_source_count', v_deleted,
      'deleted_sources', v_links
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'need_line_id', v_line.id,
    'deleted_source_count', v_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_delete_need_line(uuid, text, uuid[]) IS
  'CN-2B conformance (212): the explicit correction path for an operational need line. Authenticated, central_needs.edit on the owning organization derived from the line''s own revision, draft revisions only, a mandatory non-empty reason and the caller''s expected lineage. Deletes the line''s links and then the line atomically and writes a durable audit row with the deleted identity, scope, quantities, links and reason. Never touches source evidence or overrides. Direct DELETE stays revoked from every client role.';

-- ----------------------------------------------------------------------------
-- 4c. The exact-decimal read (independent review F5).
--
-- PostgREST serializes a `numeric` column as a JSON NUMBER, and supabase-js
-- decodes JSON with JSON.parse, so an unconstrained numeric such as
-- 12345678901234567.891 reaches TypeScript as 12345678901234568 — rounded by
-- IEEE-754 before any application code runs. Reading the tables directly can
-- therefore not honour the no-rounding contract, however carefully the
-- service stringifies afterwards.
--
-- This projection emits both quantities as TEXT, so they travel as JSON
-- strings and never pass through a JavaScript number. It is SECURITY INVOKER:
-- it grants nothing, and exactly the caller's own RLS applies — the permissive
-- `central_needs.view` policy on the owning organization AND the restrictive
-- role-class policy — so an unauthorized caller sees no row, just as a table
-- read would show none. It also returns each link's own cell identity
-- (session, row, field), so a client can show a line's REVISION-wide lineage
-- even for cells outside the import session it is looking at.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_list_need_lines(
  p_plan_revision_id uuid
)
RETURNS TABLE (
  id                          uuid,
  plan_revision_id            uuid,
  organization_id             uuid,
  beneficiary_organization_id uuid,
  target_warehouse_id         uuid,
  central_item_id             uuid,
  approved_quantity           text,
  approved_unit               text,
  unit_conversion_state       text,
  source_unit_text            text,
  mapping_reason              text,
  updated_at                  timestamptz,
  sources                     jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT n.id,
         n.plan_revision_id,
         n.organization_id,
         n.beneficiary_organization_id,
         n.target_warehouse_id,
         n.central_item_id,
         n.approved_quantity::text,
         n.approved_unit,
         n.unit_conversion_state,
         n.source_unit_text,
         n.mapping_reason,
         n.updated_at,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'source_record_id', ls.source_record_id,
                    'designated_quantity', ls.designated_quantity::text,
                    'applied_override_id', ls.applied_override_id,
                    'import_session_id', r.import_session_id,
                    'target_entity', r.target_entity,
                    'field_name', r.field_name)
                  ORDER BY r.import_session_id, r.record_ordinal, ls.source_record_id)
             FROM public.central_needs_need_line_sources ls
             JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
            WHERE ls.need_line_id = n.id
         ), '[]'::jsonb)
    FROM public.central_needs_need_lines n
   WHERE n.plan_revision_id = p_plan_revision_id
   ORDER BY n.created_at, n.id;
$$;

REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_need_lines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_need_lines(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_list_need_lines(uuid) IS
  'CN-2B conformance (212): the exact-decimal read of a revision''s operational need lines and their revision-wide provenance. approved_quantity and every designated_quantity are TEXT, so no value is rounded by a JSON-number decode on the client. SECURITY INVOKER: the caller''s own RLS (central_needs.view on the owning organization plus the role-class restriction) decides visibility; it grants nothing.';

-- ----------------------------------------------------------------------------
-- 5. Review completeness — EXTENDED, never weakened.
--
-- The five branches M211 defined are reproduced verbatim below; the 212
-- branches are appended. A revision therefore still cannot be submitted for any
-- reason it could not be submitted for before 212.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_review_blockers_v1(
  p_plan_revision_id uuid
)
RETURNS TABLE (blocker text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- 1. Nothing authoritative has landed yet.
  SELECT 'no_finalized_import'::text, NULL::text
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_import_sessions
      WHERE plan_revision_id = p_plan_revision_id AND status = 'completed'
   )

  UNION ALL
  -- 2. An attempt is still open. 'failed' is terminal history and never blocks.
  SELECT 'import_session_still_open', format('session=%s status=%s', s.id, s.status)
    FROM public.central_needs_import_sessions s
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status IN ('pending', 'processing')

  UNION ALL
  -- 3. A completed session that no registered batch claims. This is the
  --    partial-ZIP / crashed-worker case.
  SELECT 'completed_session_not_in_trusted_batch', format('session=%s', s.id)
    FROM public.central_needs_import_sessions s
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status = 'completed'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_import_batch_entries e
        WHERE e.import_session_id = s.id
     )

  UNION ALL
  -- 4. A registered batch whose declared accepted-entry count disagrees with
  --    the rows actually present. Registration is atomic, so this should be
  --    unreachable; it is defence in depth against any later writer.
  SELECT 'incomplete_trusted_batch',
         format('batch=%s declared=%s present=%s', b.id, b.accepted_entry_count,
                (SELECT count(*) FROM public.central_needs_import_batch_entries e WHERE e.batch_id = b.id))
    FROM public.central_needs_import_batches b
   WHERE b.plan_revision_id = p_plan_revision_id
     AND b.accepted_entry_count <> (
       SELECT count(*) FROM public.central_needs_import_batch_entries e WHERE e.batch_id = b.id
     )

  UNION ALL
  -- 5. A target entity in authoritative evidence with no explicit human
  --    disposition. The server never guesses which rows "need" mapping; it
  --    requires that a reviewer decided about each one.
  SELECT 'target_entity_without_disposition', format('session=%s target_entity=%s', d.import_session_id, d.target_entity)
    FROM (
      SELECT DISTINCT r.import_session_id, r.target_entity
        FROM public.central_needs_source_records r
        JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id
       WHERE s.plan_revision_id = p_plan_revision_id
         AND s.status = 'completed'
    ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.central_needs_record_mappings m
      WHERE m.import_session_id = d.import_session_id
        AND m.target_entity     = d.target_entity
   )

  UNION ALL
  -- 6. (212) A row a human dispositioned as 'mapped' that no operational need
  --    line claims. v7.3 section 8.1 requires the approved requirement to be
  --    relational, so a mapped row with no need line is an incomplete mapping.
  SELECT 'mapped_target_entity_without_need_line',
         format('session=%s target_entity=%s', m.import_session_id, m.target_entity)
    FROM public.central_needs_record_mappings m
    JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id
   WHERE s.plan_revision_id = p_plan_revision_id
     AND s.status   = 'completed'
     AND m.decision = 'mapped'
     AND NOT EXISTS (
       -- Provenance is record-level, so the row identity comes from the source
       -- record the link names.
       SELECT 1
         FROM public.central_needs_need_line_sources ls
         JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
        WHERE r.import_session_id = m.import_session_id
          AND r.target_entity     = m.target_entity
     )

  UNION ALL
  -- 6b. (212) A need line whose linked row has since been RE-MAPPED to another
  --     canonical material, or un-mapped. `central_needs_record_mappings` stays
  --     mutable by design (M210: "a mapping is a correction, not source
  --     evidence"), so the canonical mapping can legitimately change after a
  --     need line was built from it. The approved line is never silently
  --     rewritten to follow: approval blocks until a human re-designates it.
  SELECT 'need_line_material_mapping_divergent',
         format('need_line=%s item=%s source_entity=%s mapped_item=%s',
                n.id, n.central_item_id, r.target_entity,
                coalesce(m.central_item_id::text, '(unmapped)'))
    FROM public.central_needs_need_lines n
    JOIN public.central_needs_need_line_sources ls ON ls.need_line_id = n.id
    JOIN public.central_needs_source_records r     ON r.id = ls.source_record_id
    LEFT JOIN public.central_needs_record_mappings m
           ON m.import_session_id = r.import_session_id
          AND m.target_entity     = r.target_entity
   WHERE n.plan_revision_id = p_plan_revision_id
     AND (m.id IS NULL
          OR m.decision <> 'mapped'
          OR m.central_item_id IS DISTINCT FROM n.central_item_id)

  UNION ALL
  -- 7. (212) A need line whose source unit could not be converted. The
  --    conversion is never guessed, so approval waits for a human.
  SELECT 'need_line_unit_conversion_required',
         format('need_line=%s item=%s', n.id, n.central_item_id)
    FROM public.central_needs_need_lines n
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.unit_conversion_state = 'conversion_required'

  UNION ALL
  -- 8. (212) Defence in depth: a target warehouse that is not the
  --    beneficiary's. The write RPC already refuses this.
  SELECT 'need_line_warehouse_org_mismatch',
         format('need_line=%s warehouse=%s', n.id, n.target_warehouse_id)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.organization_id IS DISTINCT FROM n.beneficiary_organization_id

  UNION ALL
  -- 8b. (212) A target warehouse that is no longer ACTIVE. Ownership is not
  --     lifecycle: a warehouse can be archived or inactivated after a line was
  --     routed to it, and the write RPC's check cannot see that later change.
  --     A requirement routed to a warehouse that stopped being active must not
  --     reach approval silently; a human re-routes it (delete + map again).
  SELECT 'need_line_target_warehouse_not_active',
         format('need_line=%s warehouse=%s status=%s', n.id, n.target_warehouse_id, w.status)
    FROM public.central_needs_need_lines n
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND n.target_warehouse_id IS NOT NULL
     AND w.status IS DISTINCT FROM 'active'

  UNION ALL
  -- 9. (212) Defence in depth: a beneficiary that is no longer an eligible
  --    live care institution at review time.
  SELECT 'need_line_beneficiary_ineligible',
         format('need_line=%s beneficiary=%s', n.id, n.beneficiary_organization_id)
    FROM public.central_needs_need_lines n
    JOIN public.organizations o ON o.id = n.beneficiary_organization_id
   WHERE n.plan_revision_id = p_plan_revision_id
     AND (o.organization_kind IS DISTINCT FROM 'care_institution'
          OR o.status IS DISTINCT FROM 'active');
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) IS
  'CN-2B internal: the single definition of review completeness. Returns one row per unmet submission precondition, empty when the revision is ready. Shared by the submit gate so UI and server can never disagree about what "complete" means. Extended by 212 with operational need-line completeness; no pre-212 branch was removed or weakened.';

-- ----------------------------------------------------------------------------
-- 6. VERIFY — fail the migration rather than ship a half-applied contract.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.central_needs_need_lines') IS NULL
     OR to_regclass('public.central_needs_need_line_sources') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): need-line tables missing';
  END IF;

  -- RLS forced on both new tables.
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN ('public.central_needs_need_lines'::regclass,
                 'public.central_needs_need_line_sources'::regclass)
     AND relrowsecurity AND relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): RLS not ENABLED+FORCED on both new tables (got %)', n;
  END IF;

  -- No client write grant anywhere on the new surface.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name IN ('central_needs_need_lines', 'central_needs_need_line_sources')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): authenticated holds % direct write grant(s)', n;
  END IF;

  -- anon holds nothing at all.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'anon'
     AND table_schema = 'public'
     AND table_name IN ('central_needs_need_lines', 'central_needs_need_line_sources');
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): anon holds % grant(s) on the new surface', n;
  END IF;

  -- The accounting-scope key is warehouse-aware AND NULLS NOT DISTINCT, which is
  -- what stops two institution-level lines from double counting.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_need_lines'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) =
           'UNIQUE NULLS NOT DISTINCT (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id)'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): canonical accounting-scope UNIQUE missing or not NULLS NOT DISTINCT';
  END IF;

  -- A source record can feed at most one need line.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.central_needs_need_line_sources'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (source_record_id)'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): source-record-to-one-line UNIQUE missing';
  END IF;

  -- Exact numeric quantity with NO typmod: a scale would silently round.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'central_needs_need_lines'
       AND column_name = 'approved_quantity'
       AND data_type = 'numeric'
       AND numeric_precision IS NULL AND numeric_scale IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): approved_quantity must be unconstrained numeric (a typmod would round)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'central_needs_need_line_sources'
       AND column_name = 'designated_quantity'
       AND data_type = 'numeric'
       AND numeric_precision IS NULL AND numeric_scale IS NULL
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): designated_quantity must be unconstrained numeric';
  END IF;

  -- The deferred integrity assertion exists on BOTH tables, and is deferred:
  -- without it, mandatory lineage and the provenance sum would rest on one RPC.
  SELECT count(*) INTO n
    FROM pg_trigger t
   WHERE t.tgname = 'assert_need_line_integrity'
     AND NOT t.tgisinternal
     AND t.tgconstraint <> 0
     AND t.tgdeferrable AND t.tginitdeferred
     AND t.tgrelid IN ('public.central_needs_need_lines'::regclass,
                       'public.central_needs_need_line_sources'::regclass);
  IF n <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): deferred need-line integrity trigger missing (got %)', n;
  END IF;

  -- NaN and Infinity are refused on both quantity columns.
  SELECT count(*) INTO n
    FROM pg_constraint
   WHERE conrelid IN ('public.central_needs_need_lines'::regclass,
                      'public.central_needs_need_line_sources'::regclass)
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%NaN%'
     AND pg_get_constraintdef(oid) LIKE '%Infinity%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): non-finite quantity CHECKs missing (got %)', n;
  END IF;

  -- The client surface is exactly the two writes and the one read; the internal
  -- helpers are not callable. anon can call none of them.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
      'EXECUTE')
     OR NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
      'public.phoenix_central_needs_list_need_lines(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): authenticated cannot execute a need-line RPC';
  END IF;
  IF has_function_privilege('authenticated',
      'public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): internal beneficiary helper must not be client-callable';
  END IF;
  IF has_function_privilege('anon',
      'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)',
      'EXECUTE')
     OR has_function_privilege('anon',
      'public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon',
      'public.phoenix_central_needs_list_need_lines(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): anon can execute a need-line RPC';
  END IF;

  -- The exact read is SECURITY INVOKER, so RLS — not the function — decides.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'phoenix_central_needs_list_need_lines'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): the need-line read must be SECURITY INVOKER';
  END IF;

  -- The role-class restriction covers both new relations.
  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid IN ('public.central_needs_need_lines'::regclass,
                      'public.central_needs_need_line_sources'::regclass)
     AND NOT polpermissive
     AND pg_get_expr(polqual, polrelid) LIKE '%_phoenix_central_needs_role_eligible_v1()%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): restrictive role-class policy missing (got %)', n;
  END IF;

  -- No row-level cardinality rule survived (independent review C1): one row
  -- may feed several lines, one cell at most one.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname = '_phoenix_central_needs_assert_need_line_integrity_v1'
       AND pg_get_functiondef(p.oid) LIKE '%source_row_split_across_need_lines%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): the false one-row-one-line rule is still asserted';
  END IF;

  -- search_path pinned on every function this migration defines.
  SELECT count(*) INTO n FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('phoenix_central_needs_set_need_line',
                       'phoenix_central_needs_delete_need_line',
                       'phoenix_central_needs_list_need_lines',
                       '_phoenix_central_needs_assert_need_line_integrity_v1',
                       '_phoenix_central_needs_assert_beneficiary_v1',
                       '_phoenix_central_needs_review_blockers_v1')
     AND NOT EXISTS (
       SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c(v)
        WHERE v = 'search_path=public, pg_temp'
     );
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): % function(s) lack a pinned search_path', n;
  END IF;

  -- The extension preserved every pre-212 blocker branch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = '_phoenix_central_needs_review_blockers_v1'
       AND pg_get_functiondef(p.oid) LIKE '%no_finalized_import%'
       AND pg_get_functiondef(p.oid) LIKE '%import_session_still_open%'
       AND pg_get_functiondef(p.oid) LIKE '%completed_session_not_in_trusted_batch%'
       AND pg_get_functiondef(p.oid) LIKE '%incomplete_trusted_batch%'
       AND pg_get_functiondef(p.oid) LIKE '%target_entity_without_disposition%'
       AND pg_get_functiondef(p.oid) LIKE '%mapped_target_entity_without_need_line%'
       AND pg_get_functiondef(p.oid) LIKE '%need_line_material_mapping_divergent%'
       AND pg_get_functiondef(p.oid) LIKE '%need_line_unit_conversion_required%'
       AND pg_get_functiondef(p.oid) LIKE '%need_line_target_warehouse_not_active%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): blockers function lost a branch';
  END IF;

  -- No Central Needs permission key was added or removed.
  SELECT count(*) INTO n FROM public.permission_keys WHERE module = 'central_needs';
  IF n <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): central_needs permission key count changed (got %)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.send') THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): central_needs.send must never exist';
  END IF;

  -- NO BACKFILL. This migration creates no operational need line.
  SELECT count(*) INTO n FROM public.central_needs_need_lines;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (212): migration must not create need lines (got %)', n;
  END IF;
END;
$verify$;

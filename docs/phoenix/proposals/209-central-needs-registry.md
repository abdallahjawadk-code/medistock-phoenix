# Central Needs — CN-1A Core Registry + Security — design & impact matrix

Migration 209. Base master at time of writing: `5cfddd8a11c55b4379084c3b049e93614344ed84` (tree `853b15951f5f9c8ad871c179aee73e9ac31d5845`, migration ceiling 208). Implements exactly CN-1A from `MediStock-Central-Needs-No-Break-Development-Plan-v7.3` (2026-09-08); no later package (CN-1B/CN-2A/CN-3/CN-4A/...) is touched.

## 1. Why this exists

Central Needs is an annual pharmaceutical-needs planning layer that must stay additive over the existing operational architecture: it must never become a second stock ledger, a second transfer engine, or a second RBAC system (v7.3 section 0). CN-1A is the foundation only — plan/revision lifecycle, immutable source-file evidence, a parser-neutral import envelope, a generic override ledger, and the four `central_needs.*` permission keys. No parser, no RPC, no movement/stock integration, no audit write path — those are later packages by explicit plan scope (v7.3 section 20).

## 2. Schema (209)

Five new tables, all organization-scoped (`organization_id` denormalized onto every table for direct RLS, matching the convention on `warehouses`/`material_dispensing_suspensions` rather than requiring a join):

- **`central_needs_plans`** — annual plan header: `organization_id`, `plan_year` (unique per org), `status` (draft/active/archived), actor/timestamp fields.
- **`central_needs_plan_revisions`** — versioned revision of a plan: `revision_number` (unique per plan), `status` (draft/submitted/approved/superseded/rejected), `approved_by`/`approved_at` as a schema-enforced pair. The approval-pair CHECK deliberately allows a `superseded` revision to keep its prior `approved_by`/`approved_at` (v7.3 section 11.2: "preserve previous approved revision") rather than nulling it — only `draft`/`submitted`/`rejected` require both fields NULL, and `approved` requires both set.
- **`central_needs_source_files`** — immutable metadata for the original imported workbook: `original_filename`, `file_hash` (sha256 hex, format-checked), `byte_size`, `storage_locator` (opaque, nullable — see section 4 below), `uploaded_by`/`uploaded_at`. Enforced immutable by a `BEFORE UPDATE` trigger that unconditionally raises `central_needs_source_file_immutable`; DELETE is blocked by REVOKE alone, not a second trigger — same reasoning as migration 203: a delete-blocking trigger fires for the table owner too and would block legitimate superuser-level maintenance (a future governed migration disabling/re-enabling the trigger) for no additional security benefit over the REVOKE.
- **`central_needs_import_sessions`** — parser-neutral import-attempt envelope: `status` (pending/processing/completed/failed), `started_by`/`started_at`/`completed_at`. No sheet/row/column/workbook-family column anywhere, matching v7.3 section 8.3's CN-1A parser-independence rule.
- **`central_needs_field_overrides`** — the stable, generic override ledger from v7.3 section 8.4: `target_entity` (a stable logical identifier, plain text and not an FK — no line-level imported entity exists yet in CN-1A to reference), `field_name`, `previous_value`/`final_value` (jsonb), `override_reason` (required)/`override_note`/`override_reference`, `actor_id`. Append-only; stays empty until CN-1B/CN-2A introduce real rows to override.

All five tables use `ON DELETE RESTRICT` on `organization_id` (not the `warehouses`-style CASCADE): a hard delete of an organization that still owns Central Needs data is blocked outright, which is the safer default for data explicitly designed to be immutable evidence. See section 5 for the one open gap this creates (archival, as opposed to hard delete, is not intercepted).

## 3. Authorization

Every SELECT policy calls `public.phoenix_status_center_authorized(organization_id, 'central_needs.view')` (migration 092) — not `phoenix_profile_has_scoped_permission`. This is a deliberate v7.3-mandated choice (section 7/10), confirmed against the live function bodies: `phoenix_profile_has_scoped_permission`'s org-wide-claim allowlist (`v_org_wide_roles`, migration 187) does not include `central_warehouse_manager` — that role is deliberately resource-scoped for every other scoped-permission check in this codebase. `phoenix_status_center_authorized` has no such restriction: it grants org-wide standing to *any* role holding the permission key (or unconditionally to `super_admin`), which is exactly what a central-warehouse user granted a Central Needs key needs. Any future CN-1B RPC guard must call this same function so RLS and RPC authorization can never fork, per v7.3 section 10's "RLS and RPC authorization must agree."

No table has an INSERT/UPDATE/DELETE policy at all — all mutation grants to `authenticated` are revoked outright (`central_needs_source_files_immutable`-style lockdown, matching migration 203's "no client write grant, ever" tables). Nothing can write to these tables via the app layer until CN-1B ships real RPCs.

**Permission defaults — a judgment call, flagged explicitly (matching 203's own disclosure style):** the four `central_needs.*` keys are declared in `permission_keys` with **zero** `role_permission_defaults` rows — narrower than 203's default grants to specific roles. Rationale: v7.3 section 1 restricts Central Needs to "users actually authorized for central Pharmacy Department operations," which reads as a per-user grant, not a blanket role default; section 10's authorization matrix also says "central warehouse user with **granted** Central Needs permission → allowed," implying an explicit grant rather than a role-wide default. Access is opt-in per profile via the existing `profile_permission_overrides` mechanism (migration 010) — no new plumbing needed. If the intent was instead "every `central_warehouse_manager` gets `central_needs.view` by default," that is a one-line follow-up migration, not a CN-1A blocker.

Authorization-test matrix and how each maps onto the one function/one-policy design:

| Scenario | Mechanism |
|---|---|
| `super_admin` → allowed | `phoenix_status_center_authorized` returns `true` unconditionally for `super_admin`, any org |
| Central warehouse user with a granted key → allowed | org matches + `phoenix_profile_has_permission` resolves `true` via a `profile_permission_overrides` row |
| Same-org user without the key → denied | org matches, `phoenix_profile_has_permission` resolves `false` (no default, no override) |
| Wrong organization → denied | `v_org IS DISTINCT FROM p_organization_id` short-circuits `false` (non-`super_admin`) |
| Institution/outlet user (`institution_admin`/`outlet_officer`/`warehouse_officer`) → denied | no default grant exists for any role, so `phoenix_profile_has_permission` is `false` regardless of role |
| `anon` → denied | `REVOKE ALL ... FROM anon`; the function also requires `auth.uid() IS NOT NULL`, which `anon` never satisfies |
| Delegated cross-org access → NOT automatically granted | `phoenix_status_center_authorized` never consults the scoped/delegated permission mechanism at all — only direct org match or `super_admin` |

## 4. Deliberately deferred (v7.3-review decisions, recorded so a future package doesn't have to re-derive them)

- **Audit integration**: v7.3 lists "audit integration" under CN-1A's allowed scope, but every existing `audit_logs` writer in this codebase is an explicit `INSERT` inside a `SECURITY DEFINER` RPC body — there is no trigger-based writer anywhere in 208 prior migrations. With zero RPCs introduced here, there is nothing to hook an explicit `INSERT` into. Reviewed and confirmed: defer audit-log integration to CN-1B, when real RPCs exist. Tests below seed fixture rows via a superuser/service-role connection (the pg-rig's `asAdmin`), exactly as migration 203's own dynamic suite does for its fixtures.
- **Source-file storage**: no Supabase Storage bucket, `documents`/`attachments` table, or upload workflow exists anywhere in this codebase. `storage_locator` is a nullable opaque text column with no assumed shape — CN-1A does not invent a bucket/path convention. Real Storage wiring is a CN-2A/CN-1B concern once the import path is proven.
- **Organization archive reciprocal guard** (migrations 201/202, `_phoenix_assert_parent_not_archived_v1`): not extended to these five tables. `ON DELETE RESTRICT` blocks a hard delete of an org with live Central Needs data, but archival (`organizations.archived_at`, a soft status flip) is not intercepted by RESTRICT — an org could in principle be archived while still owning active Central Needs plans. Extending the reciprocal guard is a reasonable follow-up but touches a shared cross-cutting mechanism with its own exhaustive-table static tests, which is out of scope for a "no RPCs, tables only" package. Recorded here as the one known gap rather than silently left unmentioned.

## 5. Verification status

Static: `DO $verify$` block confirms every table + RLS enabled/forced, exactly 4 `central_needs.*` permission keys, zero default role grants for them, and the immutability trigger + its locked-down function are both present. A dedicated static test (`209-central-needs-registry-static.test.ts`) re-derives the same properties from the file text without a database. The 13 migration-registration/ceiling-ratchet guard files that hardcode "208" as the ceiling are bumped to 209 in lockstep (see the file-surface list in the accompanying commit).

Dynamic: `209-central-needs-registry.dynamic.test.ts` runs against a real disposable `postgres:18` with `001→209` applied in order (pg-rig, port 55432), proving: schema/FK/uniqueness shape; the full authorization matrix in the table above end-to-end (`super_admin`, a granted `central_warehouse_manager`, an ungranted same-org `central_warehouse_manager`, a wrong-org `central_warehouse_manager`, `institution_admin`, `outlet_officer`, `anon`); source-file creation via a privileged connection (simulating the future CN-1B RPC) followed by a rejected direct `authenticated` `UPDATE`/`DELETE`/`INSERT`; an override row referencing a revision leaving the source-file row byte-identical; and that migrations 001-208 remain byte-identical (no historical migration touched).

Compatibility: no existing table, RPC signature, or movement/stock schema is touched. `OLD_FRONTEND + NEW_SCHEMA` is unconditionally true — no frontend file is part of this diff at all, so there is nothing for a feature flag to gate yet (CN-1A introduces no UI surface).

# Suspended from Dispensing / موقوف الصرف — domain design & impact matrix

Migrations 203–207. Governed master at time of writing: `9eff7f23734cd71171af71d00dd33952e4bea1d9`.

## 1. Why this is a separate domain, not a Quarantine variant

| | Quarantine / الحجر الصحي | Suspended from Dispensing / موقوف الصرف |
|---|---|---|
| Applies to | A batch/lot/quantity (`warehouse_quarantine_stock`) | A material (`central_items.id`), org/point-scoped |
| Mechanism | Physical move to a **separate table** — structurally absent from `warehouse_stock`/`outlet_stock`, so FEFO/dispense can't see it without a special query | Physical stock **untouched** — a lookup the dispensing/FEFO/suggestion RPCs consult, not a different table |
| Stock visibility | Isolated; counted separately (`quarantine_qty` in status reports) | Fully visible, countable, receivable, unchanged |
| Resolution | Release (back to stock) / destroy (permanent) | Lift (administrative act; never touches stock) |
| Existing code | Migrations 069, 099, 104, 105, 132, 185 | New: 203–207 |

Confirmed **zero prior overlap**: `موقوف`/"suspended" already exists in this codebase for three *unrelated* entities — `profiles.status='suspended'` (user accounts), a QA supplier fixture (`'مورد موقوف'`, supplier `status='inactive'`), and platform-broadcast `pbc_status_inactive`. None of them are materials. 203's new i18n keys are all `mds_`-prefixed specifically so they never collide with `um_suspended`, `pbc_status_inactive`, etc. Also confirmed distinct from `central_items.status IN ('active','inactive','discontinued')` — a permanent catalog lifecycle, not a liftable administrative hold; 203 never reads or writes that column.

**Granularity decision**: keyed on `central_item_id` (the drug itself), not migration 150's `material_identity_key` (a finer batch/presentation fingerprint that also folds in concentration/dosage_form/unit text snapshots — designed for FEFO lot-grouping, not for "block this whole drug"). A suspension on central_item X must catch every strength/form/batch tied to that catalog row.

## 2. Schema (203)

`public.material_dispensing_suspensions`: `central_item_id` (required), `organization_id` (required governing scope), `distribution_point_id` (optional narrower scope — NULL = organization-wide, mirroring `phoenix_profile_has_scoped_permission`'s own shape), `reason_code` (7-value enum incl. `other`, which forces `reason_detail`), `reference_document`, `effective_start`/`effective_end` (half-open window), `created_by`/`created_at`, `lifted_by`/`lifted_at`/`lift_reason` (all-or-nothing).

Immutable by trigger, not convention: `_phoenix_mds_immutability_v1` forbids any UPDATE once `lifted_at` is set, and before that permits *only* the lift triple moving from NULL to complete, all three at once. DELETE is blocked by REVOKE alone (same lockout shape as 069's quarantine tables) — deliberately not a second trigger, since a trigger fires for the table owner too and would block legitimate superuser-level maintenance for no extra security benefit over the REVOKE. No client INSERT/UPDATE/DELETE grant exists at all — every mutation goes through the two RPCs below.

Single source of truth for "is this active right now": `_phoenix_is_material_dispensing_suspended_v1(central_item_id, organization_id, distribution_point_id)`. Every enforcement point below calls this — the active/lifted/window logic is never re-derived inline.

RPCs: `phoenix_suspend_material_dispensing`, `phoenix_lift_material_dispensing_suspension` (both request-id + advisory-lock + fingerprint idempotent, same pattern as `phoenix_release_quarantine_stock`), and `phoenix_get_material_dispensing_suspension_status` — a lightweight badge RPC returning only `{central_item_id, is_suspended, reason_code, effective_start}`, never `reason_detail`/`reference_document`/lift fields, so front-line roles can see *that* and *why* (coded) without reaching investigative notes.

Permissions (new `permission_keys`, seeded via `role_permission_defaults`): `.create`/`.lift`/`.view` → `super_admin`, `central_warehouse_manager`, `institution_admin` only; `.view_badge` → all five roles. This is a default judgment call, not mandated by the brief — flagging it explicitly in case the real-world role mapping differs.

## 3. Enforcement points — impact matrix

| RPC (current definition) | Path it serves | Migration wiring it in | Note |
|---|---|---|---|
| `phoenix_dispense_outlet_stock` (131) | Patient dispensing | **204** | Also covers `..._with_context` (136) — it delegates, per 136's own comment ("exactly as restrictive as the stricter of the two") |
| `_phoenix_inventory_fefo_batches_exact_v1` (150) | FEFO candidate listing — feeds `phoenix_inventory_fefo_batches`/`_pick`, and (transitively) every "guarded send" below | **205** | Warehouse-scope rows check org-wide only; outlet-scope rows check org-wide OR that exact outlet |
| `phoenix_suggest_inventory_transfers`, `phoenix_suggest_cross_org_inventory_transfer` (150) | Automated transfer/replenishment suggestions | **206** | Filter applied to the physical-batch candidate pool only; alert/need signals (shortage/surplus) are untouched — suspension removes eligibility to *move*, not the underlying shortage signal |
| `_phoenix_150_send_routed_v1`, `_phoenix_150_send_direct_v1`, `_phoenix_150_add_dispatch_line_v1` (150) | The four `phoenix_send[_direct]_warehouse_transfer_line[_fefo_guarded]` entry points, and `phoenix_add_dispatch_line[_fefo_guarded]` (draft-time) | **207** | **Unconditional** — explicitly never satisfiable via `p_fefo_override`. These load a *specific* `warehouse_stock_id` by id, so 205's list-filtering alone is not enough (a direct RPC call could still name a suspended row); each gets its own explicit check |
| `phoenix_send_warehouse_dispatch` (150) | Actually executing a dispatch (moving stock) | **207** | The authoritative, final, unconditional gate — a line can be added to a draft before its material is suspended, so this is re-checked at the moment stock actually moves, independent of what was true at add-time |

**Deliberately left open** (per the brief's "exceptional recall/return/quarantine/disposal workflows remain available"): all quarantine receive/release/destroy RPCs (099/132), return/recall RPCs (185). None of these were touched.

**Identified but not yet wired — flagging rather than guessing**:
- The emergency-replenishment corridor (migrations 164/166/168/169, `emergency-replenishment.service.ts`) — crash-cart/rescue-cart provisioning. Different eligibility model (facility-class-based, not FEFO-based); needs its own read before extending, not a copy-paste of the 205–207 pattern.
- `phoenix_create_transfer_draft_from_suggestion` — converts an already-suspension-filtered suggestion into a draft. A suggestion could in principle go stale (created before a suspension, accepted after) between suggest-time and draft-time; the actual stock movement still passes through the 207-guarded send functions downstream, so this is a defense-in-depth gap, not a hole in the primary gate. Worth closing but not yet done.

## 4. Verification status

Static: every migration's `DO $verify$` block confirms its own functions/table exist post-apply; `tsc -b`, `eslint`, `vite build`, `npm audit` all clean on the fresh clone (`D:\phoenix-qd-work`) after these changes.

Dynamic: no local disposable Postgres was reachable (Docker Desktop and Rancher Desktop both installed, in context conflict — `docker` CLI can't reach either running engine), so dynamic proof runs entirely on this repository's own CI (`pg-rig` job: a clean `postgres:18` service container replaying every migration and running the `*.dynamic.test.ts` suite). That surfaced two real, genuine defects this document did not originally disclose because they were not yet known:

- **Wrong actor in the dynamic test fixtures, not a server bug**: `phoenix_profile_has_scoped_permission` only lets a role in its own `v_org_wide_roles` list (`institution_admin`, plus `super_admin` handled earlier) satisfy a check with neither `p_warehouse_id` nor `p_distribution_point_id` set — `central_warehouse_manager` is deliberately resource-scoped and can never make an org-wide claim, regardless of `role_permission_defaults`. That is correct, pre-existing security design. The dynamic tests' fixtures used the wrong actor for an org-wide suspension; fixed to `institution_admin` (the correct actor for an org-wide administrative restriction, matching the brief's own framing).
- **Real logic bug in 203 itself, found and fixed before merge**: the table originally reused one `request_fingerprint` column for both create- and lift-idempotency. The immutability trigger correctly protected it as a core field, which meant the lift RPC's own `UPDATE ... SET request_fingerprint = v_fp` was rejected by that same trigger on every real lift call — a genuine self-inflicted deadlock the static `DO $verify$` check could never catch (it only confirms the functions exist, not that they can complete a real transaction). Fixed by adding a second column, `lift_request_fingerprint`, dedicated to the lift operation's own idempotency; `request_fingerprint` stays immutable and scoped to create, exactly as originally intended. Without this fix, a replay of the *original* suspend `request_id` arriving after a lift would also have silently minted a second row instead of being recognized as a duplicate — reusing one column for two idempotency scopes was the deeper problem, not just the trigger's strictness.

Both are now fixed in migration 203 and the dynamic test fixtures directly (203 was never successfully applied anywhere — including CI — before this fix, so editing it in place rather than layering a patch migration on top is the correct move here, not a violation of "don't edit an existing migration"). Re-verification is the next CI run; this section will be updated with the terminal pass/fail counts once it completes.

# Quarantine Domain — Audit & Closure

**Status: CLOSED — no gaps found.** This is the explicit, source-cited audit
requested alongside the Suspended-from-Dispensing work (203-208). It exists
because Quarantine and Suspended-from-Dispensing are easily conflated —
both keep a material out of circulation — but they are architecturally
distinct, and the distinction is the reason Quarantine needed no new
enforcement migrations while Suspended-from-Dispensing needed five
(204-208).

## 1. What Quarantine is

Quarantine holds physically-returned stock (from institutions/outlets back
to a central/institution warehouse) that must be inspected before it can
either rejoin sellable stock or be destroyed. It is lot/batch-scoped: a
specific returned batch, not a material or drug in general.

- **Storage**: `public.warehouse_quarantine_stock` +
  `public.warehouse_quarantine_stock_movements`
  ([069_phoenix_institution_to_central_return.sql:253,333](../../supabase/migrations/069_phoenix_institution_to_central_return.sql)).
- **Disposition RPCs**: `phoenix_release_quarantine_stock` (current body:
  [185_phoenix_return_quarantine_recall_parity.sql:1704](../../supabase/migrations/185_phoenix_return_quarantine_recall_parity.sql))
  and `phoenix_destroy_quarantine_stock` (current body:
  [132_phoenix_movement_reason_code_group_g_quarantine.sql:207](../../supabase/migrations/132_phoenix_movement_reason_code_group_g_quarantine.sql)).
- **UI**: `src/features/inventory/QuarantinePanel.tsx` +
  `quarantine.service.ts` + `useQuarantinePermission.ts` — already exposes
  bilingual (Arabic/English) status and reason display; this is the panel
  the new `MaterialDispensingSuspensionPanel.tsx` was deliberately modeled
  on.

## 2. Enforcement mechanism — structural, not a runtime gate

This is the key architectural fact, and it is stated in the codebase's own
comment, not inferred:

> "Quarantine stock lives in `warehouse_quarantine_stock` (069), a table the
> live [dispensing/FEFO] pipeline never reads."
> — [072_phoenix_inventory_intelligence.sql:633](../../supabase/migrations/072_phoenix_inventory_intelligence.sql)

Quarantined stock is **physically relocated** out of `warehouse_stock` /
`outlet_stock` into a separate table the moment it is quarantined. Every
dispensing/FEFO/replenishment/suggestion RPC audited for this work
(`phoenix_dispense_outlet_stock`,
`_phoenix_inventory_fefo_batches_exact_v1`,
`phoenix_replenish_emergency_outlet`,
`phoenix_suggest_inventory_transfers`,
`phoenix_suggest_cross_org_inventory_transfer`,
`phoenix_create_transfer_draft_from_suggestion`) selects candidate batches
exclusively from `warehouse_stock`/`outlet_stock`. None of them join or
`SELECT` from `warehouse_quarantine_stock`. Confirmed by direct grep across
every migration that references the quarantine table
(072, 125, 149, 150, 182 — the only five non-069/099/105/132/185 hits): each
is a reporting join, a reason-code vocabulary constraint on the movements
audit table, a static write-path governance check, or an identity-key
column addition — none is a dispensing/FEFO/replenishment/suggestion read
path.

This means quarantine's "cannot be dispensed" guarantee holds **by
construction**: there is no code path to bypass because there is no
dispensing code path that touches the table at all. This is why Quarantine
required zero new enforcement migrations, in contrast to
Suspended-from-Dispensing, where the suspended material *remains* in the
normal `warehouse_stock`/`outlet_stock` rows (suspension is a status
overlay, not a relocation) and therefore genuinely needed an explicit gate
added to each of 204-208.

## 3. Write lockout

`warehouse_quarantine_stock` follows the same lockout pattern used for
`material_dispensing_suspensions` (203): direct writes from `authenticated`
are revoked outright —

```sql
GRANT SELECT ON TABLE public.warehouse_quarantine_stock TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_quarantine_stock FROM authenticated;
REVOKE ALL ON TABLE public.warehouse_quarantine_stock FROM anon;
```
([069_phoenix_institution_to_central_return.sql:2446-2455](../../supabase/migrations/069_phoenix_institution_to_central_return.sql))

— so all mutation happens exclusively through the `SECURITY DEFINER`
disposition RPCs, which run as the function owner and therefore bypass the
revoked grants deliberately (never through a delete-forbidding trigger,
consistent with the rest of the schema's convention of not blocking
superuser maintenance).

## 4. RLS read scoping

`wqs_select_scoped` gates `SELECT` to the viewer's warehouse/org scope, most
recently narrowed for health-center-facility parity in
[105_phoenix_quarantine_read_policy_disposition_parity.sql:53](../../supabase/migrations/105_phoenix_quarantine_read_policy_disposition_parity.sql)
and
[185_phoenix_return_quarantine_recall_parity.sql:2279](../../supabase/migrations/185_phoenix_return_quarantine_recall_parity.sql).
No anonymous or cross-org read path exists.

## 5. Authorization on disposition

Both `phoenix_release_quarantine_stock` and `phoenix_destroy_quarantine_stock`
gate on the same call shape:

```sql
IF NOT public.phoenix_profile_has_scoped_permission(
  v_actor, 'warehouse_transfer.return_request', v_q.organization_id, v_q.warehouse_id, NULL
) THEN
  RAISE EXCEPTION 'forbidden_quarantine_release' -- / 'forbidden_quarantine_destroy'
```

Symmetric between release and destroy, scoped to the quarantined stock's own
`(organization_id, warehouse_id)` — a distribution-point actor cannot act
(the `NULL` distribution_point_id argument), which is correct: quarantine is
inherently a warehouse-side concept (returns land at a warehouse, not an
outlet/distribution point), so there is no "point-scoped quarantine" to
expose — unlike Suspended-from-Dispensing, which genuinely applies at both
scopes because dispensing itself happens at outlets/points (see §7 of
[203-material-dispensing-suspension.md](proposals/203-material-dispensing-suspension.md)
for where that distinction is exercised in the new domain's UI).

Both RPCs reuse the pre-existing `warehouse_transfer.return_request`
permission key rather than a dedicated `quarantine.*` key — an established
repo convention (quarantine disposition is one action within the broader
return-corridor permission surface), not a gap; no dedicated
`permission_keys` rows exist for quarantine and none are needed.

## 6. Idempotency / replay safety

Both RPCs follow the advisory-lock + SHA-256 request-fingerprint pattern
(`pg_advisory_xact_lock(hashtextextended(p_request_id::text, <salt>))` then
a fingerprint comparison against the existing movement row keyed by
`reference_type='quarantine_request'`/`reference_id=p_request_id`) — the
same idempotent-replay design as the rest of the schema, and notably the
*correct* version of the pattern: unlike the real bug found and fixed in
203 (where lift illegally reused create's own `request_fingerprint`
column), quarantine's release/destroy are single-action RPCs with no
create/lift pairing, so there is no equivalent column-collision risk to
check for — confirmed by reading both bodies in full.

## 7. Lineage/identity hardening

150 (`material_identity_key`) extends to
`warehouse_quarantine_stock` alongside every other stock table, with its own
collision check
([150_phoenix_material_identity_fefo_provenance_hardening.sql:167](../../supabase/migrations/150_phoenix_material_identity_fefo_provenance_hardening.sql)),
so a released quarantine batch resolves to the same canonical identity as
its destination `warehouse_stock` row before the release RPC's lot-match
check (scientific name + batch + expiry + unit + national code +
concentration + dosage form + internal batch reference + supply type +
purchase origin — the full R1.5-A comparison at
[185:1780-1791](../../supabase/migrations/185_phoenix_return_quarantine_recall_parity.sql))
allows the merge.

## 8. Test coverage (real, CI-verified)

27 dynamic pg-rig test files exercise the quarantine domain end-to-end
against a real disposable Postgres in CI, spanning its full history:
095-099, 105, 112, 123-125, 128, 132, 135, 150, 153, 157, 161-162, 170,
185 (five separate 185-prefixed suites), 187, 191, plus the cross-cutting
`pg-rig-production-authorization-baseline`, `phase2-e2e-custody-chain`,
`phase9-invariant-reconciliation`, and `r1-6-full-institutional-e2e-matrix`
suites. This is materially deeper coverage than any single new domain gets
at introduction, consistent with quarantine being a long-lived, heavily
exercised corridor rather than a recent addition.

## 9. Conclusion

No enforcement gap, no missing RLS scope, no missing permission gate, no
idempotency defect, and no UI parity gap were found. Quarantine's isolation
from dispensing is structural (physical relocation to a table no
dispensing/FEFO/replenishment/suggestion RPC reads), which is a strictly
stronger guarantee than a runtime gate can provide, and is why this audit
closes with zero required migrations — in deliberate contrast to
Suspended-from-Dispensing (203-208), which needed five enforcement
migrations precisely because it does *not* relocate stock and had to gate
every read path individually instead.

> **Current dossier scope — HOLD (2026-10-29):** FF1 below is the historical
> M230 candidate and is incomplete for the M232–235 matrix-v2 entry points.
> Do not use it as an exhaustive switch for that future schema. The separate
> unnumbered FF2 candidate and its scoped evidence are described in
> `docs/phoenix/FF2-DOSSIERS-PLAN.md`; they still require independent review and
> an owner release decision. No automatic application is authorized.

# FF1 - R1 forward-fix plan (D18, ADR 14.3) - UNNUMBERED, UNAPPLIED, KILL-SWITCH ONLY

File: `supabase/candidates/FF1_r1_forward_fix_NOT_APPLIED.sql` (one transaction, VERIFY inside). Tests: `supabase/candidates/__tests__/ff1-forward-fix.dynamic.test.ts` (static contract + FF-01..04 + a normal-sequence regression on the PG rig).
It never edits M223-M230. Its migration number is reserved only if the Owner decides to apply it. **Nothing here is evidence of a Production recovery**: the rig proves the SQL, not an operational restore (see D24: procedure only).

## What FF1 does
| Section | Effect | Guard |
|---|---|---|
| 1 | re-revokes EXECUTE on the 18 manual / material writers from every API role | VERIFY: no API role can execute any of them |
| 2 | nothing else changes: `phoenix_cn_policy.actor_scope_org` (final body from M228) is not redefined; no grant, no permission, no staffing DML | VERIFY compares its md5 before/after; the source has no administrator branch |
| 3 | the Excel freeze triggers and activation markers stay exactly as they are | VERIFY: the 4 freeze triggers and at least the 5 M229 activation guards remain; capability seal clean |

FF1 does **not** restore Excel ingestion in any form. Immutable evidence (markers, inventory, events, withdrawals, acknowledgements, attestations) is not touched.

## FF-05 (historical: "named draft Excel revision exception") - OWNER DECISION / NOT APPLICABLE TO STRICT CUTOVER
The earlier synthetic design (an owner-only exception reopening intake for an existing draft Excel revision of an activated organization) is **withdrawn from the candidate**. Under the real M229 gate (`activation_blocked_pending_excel_revisions`) an organization cannot be activated while an Excel draft/submitted revision exists, so an activated organization cannot retain one; the previous proof created that state with `session_replication_role = replica`, which bypasses the triggers and does not model a Production transition. It is therefore not recorded as an operational result, and the business contract (manual annual-need quantities only) is not weakened by a routine rollback shortcut.
Any exceptional Excel unfreeze needs a separate product-policy decision, a demonstrated reachable scenario, a Production authorization and an independent review. It stays on HOLD.
What IS tested instead (no trigger bypass, normal sequence): an existing Excel draft blocks activation; after governed withdrawal activation succeeds; a new Excel draft and Excel intake rows are then refused, with and without FF1, and `excel_import_open` stays false.

## Tests (rig only)
| ID | Proof |
|---|---|
| FF-01 | applies cleanly on a 221-shaped TEST SHAPE (001-221 + M223-M230, no M222) and on the full chain; seal clean; writers owner-only; freeze remains; second apply refused. The 221 shape is never approval to skip M222 in Production |
| FF-02 | actor_scope_org byte-identical; foreign and organization-less super_admin still denied for view/import/edit/approve |
| FF-03 | with no approver staffed, recovery only through `public.assign_profile_permissions`; the fix itself grants nothing |
| FF-04 | markers / inventory / events / withdrawals / acknowledgements digest-identical before/after; activation guards remain |
| FF-05 (revised) | normal-sequence regression above; the historical exception is not claimed |

## Operating rule
Apply only on an Owner decision, after a D24 backup and an isolated restore proof that has actually been executed and accepted.

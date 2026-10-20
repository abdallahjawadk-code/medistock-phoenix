# FF1 - R1 forward-fix plan (D18, ADR 14.3) - UNNUMBERED, UNAPPLIED

File: `supabase/candidates/FF1_r1_forward_fix_NOT_APPLIED.sql` (one transaction, VERIFY inside). Tests: `supabase/candidates/__tests__/ff1-forward-fix.dynamic.test.ts` (static contract + FF-01..05 on the PG rig).
It never edits M223-M230. Its migration number is reserved only if the Owner decides to apply it.

| Section | Effect | Guard |
|---|---|---|
| 1 | re-revokes EXECUTE on the 18 manual / material writers from every API role (kill switch) | VERIFY: no API role can execute any of them |
| 2 | append-only owner-only list `phoenix_private.central_needs_excel_unfreeze_exceptions` + routine `central_needs_unfreeze_named_revision_v1(revision, reason)` | revision must exist, be `excel`, `draft`, of an ACTIVATED organization; no foreign key (the R1 capability seal lists every relation that references plan revisions) |
| 3 | freeze guard: identical to M229, plus intake ROWS (source file / import session / import batch) of a NAMED revision are admitted | a NEW Excel revision is never admitted; org-wide state unchanged |
| 4 | `my_capabilities`: M229 body, `excel_import_open` true only for a named draft Excel revision (via `phoenix_cn_policy.excel_unfreeze_open`, scoped to a viewer of the organization) | `my_capabilities(org, NULL).excel_import_open` stays false; the W0 API gate (`callerExcelImportOpen`) reads exactly this |
| - | `phoenix_cn_policy.actor_scope_org` (final body from M228) is NOT redefined | VERIFY compares its md5 before/after; no `super_admin` branch anywhere in the file |

## FF-05 without opening Excel quantity entry outside the contract
Excel quantity entry stays closed for the organization. The only reopening is per NAMED draft Excel revision that already exists; there is no way to create an Excel revision after activation, to name a manual / approved / withdrawn revision, to name a revision twice, or to undo a name (append-only). The API still needs the wrapper authority (`central_needs.import` at the caller's home PDA) AND the per-revision flag.

## Tests (all rig-only)
| ID | Proof |
|---|---|
| FF-01 | applies cleanly on a 221-shaped history (001-221 + M223-M230, no M222) and on the full chain; seal clean; writers owner-only; second apply refused |
| FF-02 | actor_scope_org byte-identical; source has no super_admin / actor_scope_org redefinition; foreign and organization-less super_admin still denied for view/import/edit/approve |
| FF-03 | with no approver staffed, recovery only through `public.assign_profile_permissions` (committed, audited); the fix itself grants nothing and has no DML on profiles / overrides |
| FF-04 | cutover inventory, activation markers, manual events, withdrawals, acknowledgements digest-identical before/after; no DML on them in the source; exception list cannot be updated, deleted or truncated |
| FF-05 | named revision admits intake rows, every other revision stays frozen, a new Excel revision is refused, capabilities true only for the named revision (false for org-wide and for a foreign super_admin), the routine is unreachable by an API role |

## Operating rule
Apply only on an Owner decision, after a D24 backup/restore proof, then call the exemption routine once per named revision (owner-only SQL; each call is its own authorization).

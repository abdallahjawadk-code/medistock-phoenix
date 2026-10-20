# R1 release order and W0 maintenance release (corrects the earlier "W0 after R1-a" wording)

Status: RELEASE NOTE / CHECKLIST. It authorizes nothing. Every step below needs its own explicit owner authorization (merge, Vercel Production deployment, each migration, backups that read Production, feature flags).
Verified Production migration ceiling (independent read): **M221**.

## Required order
`W0 Production deploy` -> `M222` -> `M223-M228` -> checkpoint -> `M229-M230` / per-organization activation -> flag-enabled build -> one-organization pilot.
Numbered migrations are applied **exactly one per separately authorized invocation**.

## Why W0 comes first (not after R1-a)
The previous API authorized the three Excel paths with `phoenix_status_center_authorized` (M092), which returns true for any active super_admin of any organization or none. The old API paired with R1-a (M224) is the historical CUT-04 hazard. W0 moves the three paths to `phoenix_central_needs_actor_authorized` (introduced by M224) and, for the two writers, requires `my_capabilities(...).excel_import_open === true` (M226/M229). With the database still at M221 these RPCs do not exist (PGRST202) and the paths **fail closed**; there is **no fallback** to the legacy predicate. Proof: `api/_lib/__tests__/w0-endpoint-r1-absent.test.ts` (real helpers, R1 RPCs absent or answering false: 403/409, zero Storage clients, legacy helper never called), plus `w0-endpoint-wiring.test.ts` and the rig proof `w0-central-needs-excel-path-authority.dynamic.test.ts`.

## Planned consequence (requires explicit owner acceptance before the W0 deploy)
From the W0 deploy while Production remains at M221, **legitimate** legacy Excel `upload-ticket`, `finalize-import` and `source-download` (including historical downloads) are refused. This is a deliberate, fail-closed security trade-off, not a malfunction. The endpoints recover at different migration gates: **`source-download` (including historical downloads) after M224**, when the caller-scoped authorization RPC exists; **`upload-ticket` and `finalize-import` only after M226**, when `phoenix_central_needs_my_capabilities(...).excel_import_open` also exists and returns `true` for an authorized revision. At M229, Excel ingestion closes again for an activated organization by design; this is not a permission to re-enable Excel quantities. Keep the planned outage short in an owner-approved maintenance window; it is **not yet accepted** merely because this document describes it. Manual annual-need entry is not yet open during these migration steps (R1-b is later).

## Merging PR #247 is itself a Production-code event
`master` is connected to Vercel Production, so merging a PR that contains `api/` changes triggers a Production deployment. Treat the merge authorization as the **W0 maintenance release**: obtain the owner's approval of the window and of the outage above, and afterwards verify the deployed SHA equals the merge commit and the deployment is READY. (The R1 feature flag stays off.)

## Upload-token drain before activation (M229)
`createSignedUploadUrl` takes no expiry; capabilities minted before W0 stay valid for the provider's 7,200 seconds (a direct staging upload can still happen). W0 refuses their `finalize-import`, so no permanent object can be created. Before M229: wait the 7,200 s drain, then verify zero open import sessions and review Storage `staging/` orphans. **Time is not the security gate**; the database state gate and W0 are.

## Checklist
1. Owner accepts the planned Excel outage and the window. 2. Merge/deploy W0 (SHA + READY verified). 3. Confirm the three paths answer 403/409 at M221 (the negative tests above are the rehearsal). 4. M222, then M223-M228, one invocation each; seal clean after each. 5. Checkpoint: re-run the W0 rig proof against the migrated database. 6. 7,200 s drain + session/orphan check. 7. M229-M230 and per-organization activation by the owner-only routine. 8. Flag-enabled build. 9. One-organization pilot.

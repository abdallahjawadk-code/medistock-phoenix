# C5 Production Activation Orchestrator — Owner-authorized implementation specification

Status: implementation specification only. No Production action is authorized by this file itself.

Owner scope: add exactly one one-shot GitHub Actions orchestrator for C5 v1.9. It must use GitHub environment `production` and the existing environment secret named `PHOENIX_PRODUCTION_DATABASE_URL`. It must not modify M217 or `.github/workflows/apply-production-migration.yml`, and that existing workflow remains the sole M217 executor.

Required invariants:
- Base is exact master `28941ea574440651ea6fea468ed0c4d797dc3980`, tree `12473647d3f85c2affa9bcbe9cd1d930e18e3e7a`.
- M217 exact SHA-256 `7ca1fa69aecd9cfefd19fe3fd9555de10eb5edf6fc7ea68d539404549ce5e53a`.
- Pinned executor Git blob must remain `202c173d414ccd29a5f65b62077ef23219dee36f`.
- No M218+.
- Owner ledger anchor: prior attempts `0`, SHA-256 `b8be0cd2fe16bea59a18fb632d8b692e87a1ed63b5aaf23cf49954afafa3a853`.
- Reject operator `a0e492a2-231c-40ff-9996-814756bf1eaa`.
- Exact Production authorization phrase is the repository constant `PRODUCTION_AUTHORIZATION_PHRASE`; do not weaken or duplicate a different value.
- Evidence directory must be fresh and outside the repository, under `RUNNER_TEMP`, and uploaded as an artifact on every terminal path.
- `PGOPTIONS` and `PGREPLICATION` must be unset for each official C5 CLI invocation.
- Generate a fresh 14-digit UTC `PHOENIX_REMOTE_HISTORY_VERSION` before official preflight, because the reviewed C5 CLI requires and seals it during preflight; pass that exact same value to the pinned executor later.
- Run official CLI only: preflight -> freeze within 15 minutes -> resolve. Re-run resolve only on exit code 2 / DRAIN_WAIT. STOP/HOLD on any other anomaly.
- Only after exact `READY_FOR_M217`, re-prove master has not moved, then dispatch `.github/workflows/apply-production-migration.yml` via workflow_dispatch using the exact current master SHA, exact M217 filename/hash, 216 -> 217, sealed remote history version, and exact confirmation `APPLY_PRODUCTION_MIGRATION`.
- Give the orchestrator job `actions: write` only where needed; use `contents: read`; no broader permissions.
- Identify exactly one new executor run for the same head SHA, wait for terminal `success|failure|cancelled`, then invoke official `post-apply` with that run id/conclusion.
- Require final exact `C5_ACTIVATION_PASS`; otherwise fail closed and leave state governed by the CLI evidence.
- Never retry/repair M217, never terminate sessions, never edit lifecycle/audit/history directly, never run C6/Stage 3, never deploy Vercel manually.
- Use `environment: production`; secrets become available only there.
- Concurrency must serialize this one activation and never cancel in-progress.

One-shot trigger requirement:
- Workflow file: `.github/workflows/c5-production-activation-orchestrator.yml`.
- It may auto-run only on the first master push that introduces that exact file from the sealed baseline above.
- Before entering the Production environment, a non-Production gate must prove the push's prior master SHA/tree equal the sealed baseline, the merge changes exactly that one workflow file, M217 hash is unchanged, executor blob is unchanged, and M218+ count is zero.
- Any later edit/re-run from a different master predecessor must fail before Production secret access.

Use pinned action SHAs already present in the repository for checkout/setup-node/upload-artifact. Use Node 22 and `npm ci`.

Implementation destination branch: `feature/c5-production-activation-orchestrator`.

Do not merge. Do not connect to Production. Do not run the workflow. Do not modify any other file. Commit only the new orchestrator workflow and report commit SHA/tree/diffstat for independent Director review.

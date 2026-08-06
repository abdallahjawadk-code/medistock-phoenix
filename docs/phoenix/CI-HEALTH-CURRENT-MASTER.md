# CI health probe — temporary, DO NOT MERGE

This is a **temporary CI-trigger probe**. It exists for one purpose only: to
verify that GitHub Actions creates workflow runs again after the account-level
Actions budget was corrected.

- **Parent tree:** master `0c24b5906d3e3d80ed0f01623e8390b67b167cea`.
- **It changes no application code, Edge Function source, migration,
  configuration, dependency, or workflow file.** The only file added is this
  document.
- **It must not be merged.** The branch and this file are deleted once the CI
  run is recorded.
- It exists solely to prove Actions run creation on a code tree identical to
  current master, so the D3-2F execution gate can require a green CI run
  against that exact tree.

## Background

Between 2026-08-06T13:18Z and 18:13Z, GitHub stopped creating Actions workflow
runs for this repository. Read-only diagnosis established that no
`github-actions` check suite was created for three consecutive commits
(`7c66182d`, `603c1d71`, `0c24b590`) while the `vercel` and
`devin-ai-integration` suites were created normally for the same SHAs — so the
push events were delivered and only Actions produced nothing.

The repository itself was ruled out as the cause: Actions `enabled: true`,
the CI workflow `state: active`, `.github/workflows/ci.yml` unchanged and valid
with `on: pull_request` and `on: push: branches: [master]`, no path filter, no
`[skip ci]` marker, no branch protection, and no ruleset.

The cause was an account-level Actions budget of `$0` with "stop usage"
enabled, reported at 100% — which blocks run creation while leaving the
repository-level flags untouched. The owner raised the budget to the smallest
positive amount accepted, keeping "stop usage" enabled. Included allowance at
the time of diagnosis: 933 / 3000 minutes used; storage 0.2 / 2 GB.

No repository, workflow, Supabase, Vercel, or database setting was changed to
resolve it.

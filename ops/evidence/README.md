# Release evidence chain

Six files. None of them hand-typed. None of them exist in this repository
yet -- R0 is not closed and no rehearsal has run. None are committed: see
`.gitignore` (`ops/evidence/*.json`, `*.log`, `*.dump`, plus the filled-in
`ops/targets/staging.json` and `ops/targets/rehearsal-clone.json`) -- the
release engine refuses to run against a dirty worktree, so evidence output
must never collide with that gate.

```text
ops/run-pg17-restore-rehearsal.ps1
    -BackupPath <production backup> -CloneTargetManifest <rehearsal_clone manifest>
    -OutputDirectory ops/evidence
    -> restore-run-result.json
       (the ONLY tool that writes this file; every field is extracted from
       real commands run against a local, disposable, loopback PG17 clone --
       no boolean, exit code, or version is ever accepted as an input)

ops/generate-restore-proof.ps1
    -RestoreRunReportPath ops/evidence/restore-run-result.json
    -BackupPath <same backup, re-hashed and compared -- never trusted>
    -Confirmed (required, but NOT sufficient alone -- see below)
    -> restore-proof.json

ops/run-prelaunch-release-core.ps1  (target: staging)
    -> on real success, writes staging-run-result.json automatically
       (never hand-constructed, never accepted as a script parameter)

ops/generate-staging-rehearsal-proof.ps1
    -StagingRunResultPath ops/evidence/staging-run-result.json
    -RestoreProofPath ops/evidence/restore-proof.json
    -> staging-rehearsal-proof.json
       (chained to restore-proof.json via restore_proof_sha256)

ops/record-owner-go.ps1
    -> runs the FULL evidence-chain validator (Test-RestoreAndStagingEvidence
       from ops/evidence-chain.ps1) before showing anything, re-validating
       BOTH raw run-result files, not just the proofs built from them
    -> only then prompts for the exact confirmation phrase
    -> owner-go.json
       (chained to staging-rehearsal-proof.json via staging_proof_sha256)
```

## One shared validator, not two

`ops/evidence-chain.ps1` is dot-sourced by `ops/run-prelaunch-release-core.ps1`,
`ops/record-owner-go.ps1`, `ops/generate-restore-proof.ps1`,
`ops/generate-staging-rehearsal-proof.ps1` and
`ops/run-pg17-restore-rehearsal.ps1`. In particular
`Test-RestoreAndStagingEvidence` is called identically by the Production
engine and by `record-owner-go.ps1` -- the owner is shown the Go prompt only
after the exact same checks the Production engine will re-run before a
credential is ever requested. There is no lighter "just check the fields
exist" path anywhere in the chain.

## The restore rig: one tool, real commands, no shortcuts

`ops/run-pg17-restore-rehearsal.ps1` accepts exactly three inputs -- a backup
path, a `rehearsal_clone` target manifest, and an output directory. It
refuses anything that is not loopback, not `ssl_mode=disable`, or not
PostgreSQL major 17. In order, against that clone only, it:

```text
1. drops and recreates the clone database (disposable by definition)
2. pg_restores the backup into it
3. probes the restored database (connectivity, server major = 17)
4. verifies migration ceiling = 147
5. verifies the keeper account
6. verifies RBAC = 130/415
7. captures the six named immutability trigger definitions (before)
8. runs a deliberate, self-contained rollback test (a scratch table that
   must NOT exist after a forced RAISE EXCEPTION inside BEGIN...COMMIT)
9. captures the six trigger definitions again (after) and requires them
   byte-identical to step 7
10. runs reconciliation (duplicate migration versions, unvalidated FKs)
11. writes restore-run-result.json -- reached ONLY if every step above
    passed; any failure throws before this point and nothing is written
```

## Why `-Confirmed` is not enough

`ops/generate-restore-proof.ps1` requires `-RestoreRunReportPath` (the rig's
own `restore-run-result.json`) and validates every field of it, including
that the backup it names still hashes to what it claims:

```text
restore_exit_code = 0
restored_database_probe_passed = true
migration_ceiling = 147
keeper_verified = true
rbac_130_415_verified = true
trigger_definition_before_sha256 == trigger_definition_after_sha256
deliberate_rollback_passed = true
reconciliation_passed = true
clone_pg_major = 17
backup_sha256 / backup_size / backup_path / clone_server_version /
  restore_started_at_utc / restore_completed_at_utc all present and valid
```

`-Confirmed` is the operator's acknowledgement that they reviewed this report;
it never substitutes for it. A missing field, a false flag, a backup that no
longer matches, or a report that is not valid JSON fails closed before any
proof is written.

## Why the staging proof cannot be hand-assembled

`ops/generate-staging-rehearsal-proof.ps1` accepts only
`-StagingRunResultPath`, produced automatically by the release engine at the
end of a real, successful staging run -- there is no `-BackupPath` or
`-StagingServerVersion` parameter to type values into. The generator then
independently re-verifies the backup file's SHA-256 and both `psql`/`pg_dump`
executables' hash and reported version against the live filesystem; it never
trusts the run result's own claims unchecked.

## Cross-checks the Production engine (and owner-go) re-run every time

- `staging.backup_sha256 == restore.backup_sha256`
- `staging.trigger_proof_sha256` / `rollback_proof_sha256` are recomputed
  from `restore-proof.json` and compared, not merely format-checked
- `restore.clone_pg_major == production.required_pg_major` (17)
- `staging_manifest_sha256` and `staging_ca_sha256` are recomputed against
  the live staging manifest and its CA pin file (passed explicitly via
  `-StagingManifestPath`), not merely trusted from the proof
- `restore_completed_at_utc <= staging.completed_at_utc <= owner.decision_at_utc`
- **The raw `restore-run-result.json` and `staging-run-result.json` are
  re-loaded and re-validated with the exact same `Test-RestoreRunReport` /
  `Test-StagingRunResult` functions the generators used** (via
  `-RestoreRunResultPath` / `-StagingRunResultPath`), and their current
  SHA-256 must still match `restore.restore_run_report_sha256` /
  `staging.staging_run_result_sha256` -- editing or deleting either raw file
  after its proof was generated invalidates the proof. Their own
  `backup_sha256`, `head_sha`, `server_version`, and `psql`/`pg_dump`
  path/version/hash must also still agree with the proof built from them.

Any placeholder, missing field, or mismatch anywhere in this chain:
`STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED`, before any credential prompt.

## Why these files are not committed ahead of time

A committed "example" with plausible-looking hashes would be indistinguishable
from real evidence to a careless reviewer. The generator scripts (and the one
restore rig) are the only supported way to produce these files, and they
refuse to run against anything but real, already-completed rehearsal
artifacts on disk. `.gitignore` also keeps them from ever being committed by
accident.

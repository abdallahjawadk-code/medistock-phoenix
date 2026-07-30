# Release evidence chain

Four files. None of them hand-typed. None of them exist in this repository
yet -- R0 is not closed and no rehearsal has run.

```text
ops/generate-restore-proof.ps1
    -RestoreRunReportPath <structured JSON from the restore tooling>
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
       from ops/evidence-chain.ps1) before showing anything
    -> only then prompts for the exact confirmation phrase
    -> owner-go.json
       (chained to staging-rehearsal-proof.json via staging_proof_sha256)
```

## One shared validator, not two

`ops/evidence-chain.ps1` is dot-sourced by `ops/run-prelaunch-release-core.ps1`,
`ops/record-owner-go.ps1`, `ops/generate-restore-proof.ps1` and
`ops/generate-staging-rehearsal-proof.ps1`. In particular
`Test-RestoreAndStagingEvidence` is called identically by the Production
engine and by `record-owner-go.ps1` -- the owner is shown the Go prompt only
after the exact same checks the Production engine will re-run before a
credential is ever requested. There is no lighter "just check the fields
exist" path anywhere in the chain.

## Why `-Confirmed` is not enough

`ops/generate-restore-proof.ps1` requires `-RestoreRunReportPath`, a
structured JSON report from the actual restore tooling, and validates every
field of it:

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
```

`-Confirmed` is the operator's acknowledgement that they reviewed this report;
it never substitutes for it. A missing field, a false flag, or a report that
is not valid JSON fails closed before any proof is written.

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

Any placeholder, missing field, or mismatch anywhere in this chain:
`STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED`, before any credential prompt.

## Why these files are not committed ahead of time

A committed "example" with plausible-looking hashes would be indistinguishable
from real evidence to a careless reviewer. The generator scripts are the only
supported way to produce these files, and they refuse to run against anything
but real, already-completed rehearsal artifacts on disk.

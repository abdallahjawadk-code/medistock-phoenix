# ADR-001 — Purge the current Production project, or replace it

**Status:** Proposed — decision pending the R0 staging rehearsal
**Date:** _to be filled at decision time_
**Deciders:** Abdallah Jawad (owner)
**Context source:** canonical decision memory v12 §1.3, §R0-8

---

## Context

Production (`eyrzxgfkvqybjdgyphap`, PostgreSQL 17.6.1.127) holds data the owner
has declared to be entirely pre-launch test data. Two ways to reach a clean
launch state:

- **Option A — purge in place.** Run the Option-A purge on the existing project.
- **Option B — new Production project.** Stand up a clean project, replay the
  reviewed baseline, and cut over.

v11 makes Option A the primary path *conditionally*: it is authorized only after
an exact, successful, restorable, PG17-matched staging rehearsal.

## Decision

_To be recorded after R0-8. Do not fill in before the rehearsal completes._

## Go criteria — Option A requires ALL of these

| # | criterion | status | evidence |
|---|---|---|---|
| 1 | Production backup restored and verified in staging/clone | ☐ | |
| 2 | Identical rehearsal passed with no modification to the path | ☐ | |
| 3 | PostgreSQL 17 parity for rig and client tools | ☐ | |
| 4 | TLS `verify-full` proven for both `psql` and `pg_dump` | ☐ | |
| 5 | Immutability triggers disabled and restored inside one transaction, definitions identical | ☐ | |
| 6 | Zero operational data confirmed (nothing outside migration 004's demo seed) | ☐ | |
| 7 | Rollback and reconciliation documented and exercised | ☐ | |
| 8 | Owner approval recorded | ☐ | `ops/evidence/owner-go.json`, generated only by `ops\record-owner-go.ps1` after criteria 1-7 verify clean |

Any unmet criterion ⇒ **No-Go**. Criteria 1, 2 and 7 are the exact fields the
release engine re-verifies from `ops/evidence/restore-proof.json` and
`ops/evidence/staging-rehearsal-proof.json` before any Production credential
prompt — see [STATE.md](../STATE.md) and [ops/evidence/README.md](../../ops/evidence/README.md).

## No-Go triggers — automatic switch to Option B

1. A Production backup cannot be verifiably restored.
2. Trigger disable/restore cannot be proven atomic with identical definitions.
3. The staging path fails twice after documented independent fixes.
4. Real operational data appears, contradicting `PRELAUNCH_EMPTY`.
5. Irreconcilable drift between Production and migrations 001–147.
6. A uniform, safe `verify-full` connection cannot be established for both tools.
7. Key-rotation cost for a new project is lower than the cleanup risk.

## Option A — consequences

**Keeps:** project ref, API keys, Auth configuration, Vercel wiring, Edge
Functions, and the existing purge runner with its test suite.

**Costs and risks:** the purge is irreversible in place; it depends on the
immutability-trigger exception behaving exactly as rehearsed; and it inherits any
undetected drift between Production and migrations 001–147. Recovery depends
entirely on the restore proof from R0-3.

## Option B — consequences

**Keeps:** a guaranteed-clean starting state with no reliance on purge
correctness, and the old project stays intact and read-only as a rollback window.

**Costs and risks:** new project ref and keys; Auth, Vercel, Edge Function and
secret rewiring; the keeper account must be recreated and verified; and a cutover
window with its own failure modes.

```
new Supabase project
-> replay/restore reviewed baseline
-> create verified keeper
-> apply 148-153
-> verify RBAC/RLS/Auth/Storage
-> switch Vercel and secrets
-> smoke tests
-> keep old project read-only during the rollback window
```

## Notes

Deciding **not** to decide yet is itself safe: Production stays untouched. The
expensive mistake would be running Option A on an unproven assumption, which is
exactly what the criteria above are designed to prevent.

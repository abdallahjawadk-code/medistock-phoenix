# ARCHITECTURE — long-lived decisions and contracts

> Source of long-term decisions. Current status lives in [STATE.md](STATE.md);
> completed stage reports in [HISTORY/](HISTORY/).
> Derived from canonical decision memory **v11** (2026-07-30), which supersedes
> v10 and the earlier S0–S11 plans.

---

## 1. Approved architecture

**Phoenix Progressive Enterprise Architecture**

```
Secure Modular Monolith
+ PostgreSQL Transactional Kernel
+ Canonical Movement Ledgers
+ Custody and FEFO Invariants
+ Domain State Machines
+ Transactional Outbox
+ Idempotent Durable Workers
+ Selective CQRS Read Models
+ RLS/RBAC Enforcement
+ Progressive Observability
+ Optional external workflow engine only after measured need
```

Rejected for now: full microservices, Kafka, complete event sourcing.
Deferred to J, subject to evidence: Camunda / Temporal.

## 2. Legal truth

Inventory truth lives **only** in PostgreSQL: stock, batches, FEFO, movements,
custody, receipt, dispensing, quarantine, corrections, immutable audit.

No workflow engine, worker, or read model may write balances directly.

### Transaction rule

```
validate -> authorize -> lock -> re-read live state -> apply legal change
  -> write movement/custody/audit -> write outbox event -> COMMIT
```

Any failure rolls back entirely.

### Outside the transaction

Notifications, reminders, escalation, projections, analytics, OCR,
integrations, forecasting. Every consumer must be idempotent and replay-safe.

## 3. Release strategy

```
KEEP CURRENT PRODUCTION PROJECT
+ CREATE ISOLATED STAGING / PRODUCTION CLONE
+ REHEARSE THE EXACT PURGE AND MIGRATION PATH THERE
+ RUN THE IDENTICAL PROVEN PATH ON PRODUCTION ONLY AFTER GO/NO-GO
```

A dump is not a backup until it has been restored. The first full execution of
this path must never be against Production.

### Automatic fallback to a new Production project

Any one of these forces Blue/Green replacement instead of purging in place:

1. A Production backup cannot be verifiably restored into staging/clone.
2. Immutability-trigger disable/restore cannot be proven inside one transaction
   with identical definitions before and after.
3. The full staging path fails twice after documented independent fixes.
4. Real operational data appears, contradicting `PRELAUNCH_EMPTY`.
5. Irreconcilable drift between Production and migrations 001–147.
6. A uniform, safe `verify-full` TLS connection cannot be established for both
   `psql` and `pg_dump`.
7. Key-rotation cost for a new project is lower than the cleanup risk (per ADR).

## 4. TLS and client contract

| rule | value |
|---|---|
| sslmode | `verify-full` **always** |
| forbidden | `require`, `prefer`, `allow`, `disable` |
| trust root | explicit Supabase CA at a canonical path, **SHA-256 pinned** |
| `sslrootcert=system` | **not** default; allowed only after automated proof on the target machine for both `psql` and `pg_dump` |
| client major | must **equal** the Production server major (currently **17**) |
| PG18 | optional forward-compatibility CI job, non-blocking |

The certificate is public, so pinning is not about secrecy — it fixes *which*
trust root is acceptable, so a substituted file fails closed. A missing, empty,
or mismatched certificate must abort **before** the password prompt.

The password never reaches argv, a file, a transcript, or a connection string;
it travels only in `PGPASSWORD` inside the child process environment and is
zeroed in `finally`.

Client-major **equality** rather than `>=`: a newer `pg_dump` can emit archive
features an older server cannot restore, which would make the backup unusable
precisely when it is needed.

## 5. Purge contract (Option A)

Target state:

```
CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147
  = clean schema 147
  - every row seeded by migration 004 (demo hospitals, warehouses, outlets,
    catalog, availability, QR)
  + exactly one keeper account, resolved BY EMAIL
  + RBAC reference data (permission_keys 130, role_permission_defaults 415)
```

Deliberately emptier than a fresh `001→147` replay; migration 004's demo seed is
**not** re-created. Verified: none of migrations 148–153 reference its UUIDs.

- 70 purge tables / 2 preserve / 2 keeper-scoped / 2 external (Storage).
- Delete order is topological over **ordering-forcing** FKs only
  (`RESTRICT`/`NO ACTION`); `CASCADE` and `SET NULL` edges do not constrain
  order, and excluding them is what makes the graph orderable at all.
- Storage is a **precondition**, not a postcondition: deleting `storage.objects`
  rows in SQL does not delete the underlying files, so a zero row count there
  would be a false zero-state.
- Six application immutability triggers are disabled **by name** inside the
  transaction against an audited allowlist, and proven byte-identically restored
  before `COMMIT`. Never `DISABLE TRIGGER ALL`, never
  `session_replication_role`, never FK or system triggers.
- One transaction, `SERIALIZABLE`, advisory-locked, no retry, and no exception
  handler that could convert failure into success.

## 6. Stage discipline (A–J)

Every phase splits into:

```
XA — read-only discovery and contract map
XB — implementation and proof
```

and must document: entry criteria, scope, out of scope, threat/invariant model,
migrations and compatibility, focused tests, full regression, rollback and
reconciliation, exit criteria, updated STATE/HISTORY.

```
DISCOVER CONTRACTS FIRST -> DESIGN SECOND -> EXECUTE LAST
```

No scope expansion without an ADR or explicit owner approval.

### Phase summary

| phase | subject |
|---|---|
| A | institutional boundaries, identity, authorization |
| B | canonical medicine catalog and pharmaceutical identity |
| C | transactional inventory kernel (incl. the commitments/reservation decision) |
| D | supply/transfer/receipt, Outbox, minimum observability |
| E | outlets and emergency replenishment |
| F | patient dispensing and clinical context |
| G | availability, QR, search, selective CQRS |
| H | reporting, audit, recall, physical count, reconciliation |
| I | intelligence and durable operations (advisory only) |
| J | security, resilience, governance, institutional rollout |

Phase C must explicitly resolve, not defer:

```
Option 1: commitments are advisory; execution always revalidates live stock
Option 2: available-to-promise = stock - active soft commitments
```

A commitment may not be called a reservation without a contract covering
expiry, release, cancellation, and tests.

Phase D builds on the three existing corridors (central→institution,
warehouse→outlet, outlet→warehouse). No fourth ledger or corridor.

Phase I intelligence is advisory: it never moves stock except by invoking a
legal command that re-validates everything.

## 7. Pilot launch boundary

```
R0 closed + A + B + C + D + E + F + H-minimum + J-minimum
```

**H-minimum:** stock and movement reports, custody and receipt reports,
reconciliation, batch traceability, audit export.

**J-minimum:** verified backup/restore, structured logging, security monitoring
baseline, rollback runbook, break-glass procedure, load/concurrency acceptance
at pilot scale.

Phase I does not block the first real deployment. Advanced G/CQRS, I, and full J
follow the pilot.

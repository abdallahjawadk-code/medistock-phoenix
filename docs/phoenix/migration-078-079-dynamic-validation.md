# Migrations 078–080 — dynamic validation record

Migrations 078, 079 and 080 were **executed**, not merely reviewed. This file is
the evidence, so a reader can tell which claims are proven and which are still
analysis.

**Nothing was applied to the production database.**

## Environment

| | |
|---|---|
| Cluster | throwaway, created with `initdb`, destroyed afterwards |
| Version | **PostgreSQL 18.4** (production is 17.6 — 18 was the closest major locally available; Docker was unavailable, daemon not running) |
| Port | 127.0.0.1:55432, separate from the unrelated server on 5432 |
| Applied | migrations **001 → 080, in order** |

Supabase platform objects the migrations assume (`auth.uid()`, `auth.users`,
roles `anon`/`authenticated`/`service_role`, `supabase_migrations`) were
bootstrapped locally. `auth.uid()` reads a session GUC so tests can impersonate
an actor without GoTrue.

## Two things the replay uncovered

**1. Migration 023 cannot be replayed from scratch.** Its VERIFY block reads
`pg_policies.qual` for `dp_insert_perm`, which is an **INSERT** policy —
PostgreSQL stores those in `with_check` and leaves `qual` NULL, so the assertion
`v_insert_src IS NOT NULL` can never pass. The policy itself is created
correctly by 021 and is present.

This is a **pre-existing latent defect** in a migration that is already applied
to production and is immutable by repo policy. It was shimmed **in memory, in
the disposable environment only** (`coalesce(qual, with_check)`); no repository
file was modified. It has no effect on production, where 023 is already
recorded as applied — but it does mean **the 001–077 chain is not currently
replayable from empty**, which matters for disaster recovery and for standing up
a fresh environment. Worth fixing in a future migration that re-runs the
corrected assertion.

**2. Migration 062 requires seed data.** It aborts unless at least one active
`super_admin` profile exists. That is a legitimate precondition, not a bug; the
disposable run seeded one. Its last-super-admin protection then correctly
refused to scope that profile to an organization.

## Concurrency results — 27/27 passed

Real separate connections and transactions, genuine lock contention.

| Scenario | Result |
|---|---|
| Two devices, same **new** lot, both expect generation 0 | first commits; second raises `warehouse_receipt_generation_conflict` (**40001**) |
| Ledger after that race | **30, not 60**; generation advanced exactly once; **one** lot row |
| Two devices, same **existing** lot, same generation | exactly one commits; total 15, not 20 |
| Different quantities at the same generation | exactly one wins; the losing 99 was never applied |
| Lost response, **same request id** replayed with a now-stale generation | succeeds, `idempotent_replay: true`, no double-post, generation unchanged |
| Same request id, **changed payload** | rejected `request_id_conflict` (**23505**) — distinct from the 40001 conflict |
| Legitimate later receipt after canonical reload | accepted; accumulates to 20; generation → 2 |
| Metadata-only `UPDATE` | generation **unchanged** |
| Quantity `UPDATE` | generation **+1, exactly once** |
| Client writes `movement_seq = 999` directly | **ignored** — server-owned |
| No-batch receipts (see below) | form two separate lots, neither accumulates |
| 079: NULL expected generation | **refused**, `expected_generation_required` (23514) |

### A design property worth knowing

My first test run appeared to show the guard failing. It was the **test** that
was wrong, and the finding is worth recording: for a receipt with **no batch
number**, migration 065 derives `internal_batch_reference` from the request id,
so two independent no-batch receipts are **separate lots by construction** and
can never accumulate into one another. The double-post risk 078 closes is
specific to **batch-identified** lots, which share identity. Both behaviours are
now asserted.

## Cutover (080) verified as `authenticated`, not as superuser

Running as `postgres` would have masked the whole point of a REVOKE.

* legacy `phoenix_receive_warehouse_stock` → **denied** to `authenticated`
* `phoenix_receive_warehouse_stock_guarded` → **still works end to end**,
  because it is SECURITY DEFINER and executes the revoked body as its owner
* `has_function_privilege('authenticated', …)`: bare names **false**, `_guarded`
  names **true**

## Post-conditions after 078/079

* `movement_seq` — present, `NOT NULL`, `DEFAULT 0`
* trigger `warehouse_stock_bump_movement_seq` — attached and enabled (`O`)
* overload counts — **1 each** for all four functions; no ambiguity introduced
* both guarded RPCs — `SECURITY DEFINER`, `search_path = public, pg_temp`

## What is still NOT proven

* Behaviour on **PostgreSQL 17.6** specifically. Nothing used here is
  version-sensitive (advisory locks, `FOR UPDATE`, BEFORE-UPDATE triggers,
  SQLSTATE semantics are all long-stable), but the run was on 18.4.
* Behaviour under **Supabase's real PostgREST and RLS roles**, rather than the
  locally bootstrapped equivalents.
* Anything about **blockers 2 and 3**, which are not implemented.

## Reproducing

The harness is disposable and lives outside the repository (scratchpad):
`initdb` a cluster on a spare port, bootstrap the Supabase-shaped objects, apply
`supabase/migrations/*.sql` in filename order, seed an active `super_admin`, then
run the concurrency script. It is deliberately not committed — it is a
throwaway rig, not a maintained test suite, and committing it would imply CI
runs it, which it does not.

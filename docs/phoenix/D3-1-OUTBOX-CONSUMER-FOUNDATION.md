# D3-1 — Outbox Consumer State Foundation

Migration: `supabase/migrations/163_phoenix_outbox_consumer_foundation.sql`
Status: database-side infrastructure only. No worker exists yet.

## Boundaries

D3-1 adds exactly two tables and four internal functions. It does **not**
add: a worker, an Edge Function, HTTP delivery, `pg_net`, `pg_cron`,
LISTEN/NOTIFY, or a scheduler. It never mutates or deletes a
`phoenix_outbox_events` row, and it never touches any D2 producer
(158/159/161/162). All of this is proven in-transaction by the migration's
own VERIFY block and independently re-proven by this PR's dynamic tests.

Two new tables:

- **`phoenix_outbox_consumers`** — a small, slow-changing, operator-managed
  registry. One row per logical consumer. `organization_id NULL` means a
  global consumer eligible across every organization; a non-null value
  scopes it to exactly that organization. No secrets or endpoint
  credentials belong on this table by design — a future worker phase reads
  its own connection details from its own deployment environment, never
  from the database.
- **`phoenix_outbox_delivery_state`** — the actual runtime state machine, one
  row per `(consumer, Outbox event)` pair, created lazily and idempotently
  by `phoenix_outbox_claim_batch`'s own discovery step.

Four new internal functions, all `SECURITY DEFINER`, pinned
`search_path = public, pg_temp`, executable only by `service_role` (no new
role was invented — see "Security model" below):

- `phoenix_outbox_claim_batch(consumer_key, lease_token, batch_size)`
- `phoenix_outbox_mark_completed(consumer_key, delivery_state_id, lease_token)`
- `phoenix_outbox_mark_failed(consumer_key, delivery_state_id, lease_token, error_code, error_summary)`
- `phoenix_outbox_release_lease(consumer_key, delivery_state_id, lease_token)`

## State machine

```
(created)   -> pending      claim_batch's own discovery step
                             (idempotent — ON CONFLICT DO NOTHING)
pending     -> leased       claim_batch (FOR UPDATE SKIP LOCKED)
leased      -> completed    mark_completed                        [terminal]
leased      -> pending      mark_failed, attempt_count < max_attempts
                             (attempt_count += 1, available_at = backoff)
leased      -> dead_letter  mark_failed, attempt_count >= max_attempts
                             (attempt_count += 1)                  [terminal
                             under D3-1 — see "Deferred work"]
leased      -> pending      release_lease (cooperative; attempt_count
                             UNCHANGED)
leased      -> pending      claim_batch's own expired-lease reclaim
                             (attempt_count UNCHANGED — deliberate, see below)
completed   -> completed    mark_completed replayed with the SAME lease
                             token that completed it (idempotent no-op)
dead_letter -> (nothing)    no function in this migration ever reads a
                             dead_letter row back into pending/leased
```

**Deliberate design decision:** expired-lease reclaim never increments
`attempt_count`. Only an explicit `mark_failed` call — a worker actually
reporting a failure — burns an attempt. This keeps "a slow event" and "an
event a worker gave up on" as two separately observable facts, and keeps
D3-1 to exactly the transitions its own test suite proves, not a broader
retry-on-timeout policy invented without a corresponding requirement.

`lease_owner_token` is retained forever once first set — only
`lease_expires_at` is cleared when a row leaves `'leased'`. This is what
makes `mark_completed`'s idempotent-replay check possible: a second call
with the *same* token that already completed the row succeeds silently (a
caller retrying after a dropped response — a well-known at-least-once
hazard); a call with a *different* token is rejected as foreign, exactly as
if it had never completed anything.

## Claim/lease protocol

1. **Discovery.** `claim_batch` materializes `pending` delivery-state rows
   for events the calling consumer has not seen yet, cursored by
   `last_discovered_stream_position` (see "Why `stream_position`" below),
   bounded per call, and idempotent under concurrent execution
   (`ON CONFLICT (consumer_id, outbox_event_id) DO NOTHING`; the cursor
   itself only ever advances via `GREATEST(current, newly_seen_max)`, so it
   can never move backward even if two calls race).
2. **Expired-lease reclaim.** Any row this consumer holds with
   `status = 'leased'` and an expired `lease_expires_at` is returned to
   `pending` before the claim step runs.
3. **Claim.** `SELECT ... FOR UPDATE SKIP LOCKED` over eligible pending rows,
   bounded by `batch_size`, then a single `UPDATE` sets `status='leased'`,
   stamps the caller's `lease_token` and a server-computed
   `lease_expires_at`. Two concurrent `claim_batch` calls for the same
   consumer never receive overlapping rows and never block each other.
4. The caller gets back the event's own data (key, type, payload, etc.)
   joined against the delivery-state identity it must present to
   `mark_completed`/`mark_failed`/`release_lease`.

## Retry and dead-letter rules

- `mark_failed` requires the exact active lease token; a stale (expired) or
  foreign token is rejected.
- `attempt_count` increments exactly once per `mark_failed` call.
- Retry availability is computed **server-side**, never caller-supplied: a
  deterministic exponential backoff, `LEAST(30 * 2^(attempts-1), 3600)`
  seconds (30s, 60s, 120s, ... capped at 1 hour).
- Reaching `max_attempts` (a per-consumer, operator-configured value)
  transitions the row to `dead_letter` in the same call, exactly once.
- `error_code`/`error_summary` are bounded (100/500 chars) and defensively
  truncated rather than raising — a diagnostics-recording path must never
  itself fail because the error being recorded was too descriptive. Only
  these two bounded text parameters are accepted; there is structurally no
  parameter for headers, stack traces, JWTs, or request bodies.

## Organization scoping

`phoenix_outbox_delivery_state.organization_id` is always copied from the
referenced `phoenix_outbox_events` row at discovery time — it is never a
function parameter on any of the four functions, so no caller can override
it. An org-scoped consumer's discovery query filters
`e.organization_id = consumer.organization_id`; a global consumer
(`organization_id IS NULL`) is explicitly, server-configuredly eligible
across every organization. This asymmetry is intentional and
operator-controlled (creating a global consumer is a deliberate registry
action), not a default any caller can request.

## Idempotency model

- **Delivery-state creation:** `UNIQUE(consumer_id, outbox_event_id)` plus
  `ON CONFLICT ... DO NOTHING` — a duplicate discovery attempt is a safe
  no-op, never a second row.
- **Completion:** replaying `mark_completed` with the same lease token that
  already completed the row returns the same success result; the actual
  `UPDATE` never re-runs.
- **Claiming:** `FOR UPDATE SKIP LOCKED` guarantees a row already leased
  (by anyone, including a concurrent call from the same consumer) is simply
  skipped, never double-claimed.

## Concurrency model

Every write path relies on ordinary Postgres row-level locking under READ
COMMITTED — no advisory lock was introduced (none was needed): `SKIP LOCKED`
for claiming, `ON CONFLICT DO NOTHING` for idempotent discovery-row
creation, `FOR UPDATE` inside `mark_completed`/`mark_failed`/`release_lease`
to serialize concurrent actions against the *same* delivery-state row, and a
`GREATEST`-guarded plain `UPDATE` for the discovery cursor (which needs no
lock at all, since Postgres itself serializes concurrent writers to the
same row).

## Security model

No new database role was invented. Migration 109 (`ALTER DEFAULT
PRIVILEGES FOR ROLE postgres ... GRANT EXECUTE ON FUNCTIONS TO
service_role`) already makes every function `postgres` creates
automatically `EXECUTE`-able by `service_role` — Supabase's own standard
trusted-backend role — with zero default access for
`authenticated`/`anon`/`PUBLIC`. This is unlike `phoenix_demo_purger` (141),
a narrow `NOLOGIN` role invented for one unusually dangerous operation
(bulk demo-data deletion); D3's claim/complete/fail functions are ordinary
trusted-backend RPCs with no comparable reason to invent a new role. Every
function still carries an explicit `REVOKE ALL ... FROM PUBLIC,
authenticated, anon` — belt-and-suspenders, matching this repository's
universal convention, even though 109's own defaults already guarantee it.

Both new tables are RLS-enabled with zero policies, matching
`phoenix_outbox_events`'s own posture — no client-facing access of any kind.

## Why Outbox source rows remain immutable

`phoenix_outbox_events` is the single source of truth for "what happened."
D3-1 never `UPDATE`s or `DELETE`s a row in it (proven both in-transaction
and by dedicated static/dynamic tests) — every fact a consumer needs about
its own processing progress (claimed, completed, failed, dead-lettered)
lives entirely in the two new tables this migration owns. This keeps the
event ledger trustworthy regardless of how many consumers exist or how they
each fare, and keeps a future replay/redrive mechanism trivial to reason
about (it would only ever need to touch delivery-state rows, never the
events themselves).

## Why `stream_position` is not business order

158's own header is explicit: `stream_position` is "a stable technical
pagination/tie-break column only" — never global business order, never
causal order, never organization order. D3-1 uses it for exactly that
stated purpose: each consumer's own `last_discovered_stream_position`
cursor lets discovery scan only events strictly newer than what that one
consumer has already seen, instead of re-scanning the unboundedly-growing
`phoenix_outbox_events` table on every call. This is not a claim of
gap-free-ness — a dedicated test (`does not assume gap-free stream_position`)
proves discovery works correctly even when positions are non-contiguous
from a given consumer's perspective.

## Explicitly deferred D3 work (not in this PR)

- The actual worker process.
- An Edge Function or any HTTP delivery mechanism.
- `pg_net`, `pg_cron`, or any scheduler.
- Consumer-specific handlers (what a given consumer actually *does* with a
  claimed event).
- A replay/redrive mechanism for `dead_letter` rows.
- A UI for consumer registration, delivery-state inspection, or manual
  replay.
- External integrations of any kind.
- D3-2 and beyond.

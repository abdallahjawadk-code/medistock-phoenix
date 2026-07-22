# Migration 084 — catalogue-visibility setter: audit and dynamic validation

**Nothing was applied to production.** Migration 084 was executed on a disposable
PostgreSQL 18.4 cluster with **001→084 applied in filename order** via
`tools/pg-rig`. Production is 17.6; nothing in 084 uses an 18-only feature.

```
PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres node tools/pg-rig/apply.mjs 84
# → OK — chain applied through 84 in ~3s; public functions: 209
PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres \
  npx vitest run supabase/migrations/__tests__/084-availability-visibility.dynamic.test.ts
# → 6 passed
```

## Why

Migration 053 added `item_availability`'s removed marker
(`removed_at`/`removed_by`/`removal_reason`) — pure catalogue visibility,
independent of physical stock (which 083 made canonical). Until 084 the only way
to CLEAR that marker was a side effect of `phoenix_upsert_availability`'s
reactivation branch — a manual **quantity-writer** path that forced an operator
to re-type a quantity into a projection that is no longer stock truth. 084
decouples the two so the manual quantity writers can later be revoked (085,
prepared) without taking catalogue visibility down with them.

## What 084 adds

`phoenix_set_availability_visibility(item_availability_id uuid, hidden boolean,
reason text)` — symmetric hide/reactivate that edits ONLY the three removed-marker
columns plus `last_updated_by`. It never reads or writes `quantity`/`condition`.
`SECURITY DEFINER`, search-path pinned, org-scoped from the LOCKED row, reuses the
existing `availability.update` permission key (no new RBAC key). Least-granted:
revoked from `PUBLIC`/`anon`, `EXECUTE` to `authenticated`.

## Dynamic results (real RPC on the rig) — 6/6

| Case | Proven |
| --- | --- |
| reactivate (hidden=false) | clears removed_at/by/reason; quantity 42 and condition 'available' UNCHANGED |
| hide (hidden=true) | sets removed_at + reason; quantity 42 and condition UNCHANGED; echoes quantity |
| same-org updater | a `hospital_admin` (has availability.update) may reactivate |
| same-org viewer | a `viewer` (no availability.update) → `forbidden_availability_update` |
| foreign-org actor | scope from the locked row → `forbidden_cross_org` |
| missing row | `availability_not_found` |

Static contract: `084-availability-visibility.test.ts` — all green.

The related cutover migration **085** (revoke of the manual quantity writers) is
**PREPARED only** and proven fail-closed: applying the chain through 085 without
`SET phoenix.availability_cutover_attested='true'` aborts at 085 with a refusal
message, and the rig is left at 084.

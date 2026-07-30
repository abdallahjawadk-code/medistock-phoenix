# Staging rehearsal runbook — R0

Prove the exact purge and migration path on an isolated environment **before**
Production is touched. Canonical memory v11 §R0-2 … §R0-8.

> No step here connects to Production except explicitly read-only Management API
> calls and one owner-run backup export. Production is never written to.

---

## Entry criteria

All must hold before starting:

- [ ] PR #68 CI green; local HEAD == PR head; worktree clean
- [ ] PostgreSQL **17.x** client tools installed (`psql` and `pg_dump`, same
      distribution) — the runner refuses anything else
- [ ] `ops/certs/supabase-prod-ca.crt` present and pinned via
      `ops\pin-supabase-ca.ps1`
- [ ] Staging Supabase project created (owner action — account/billing)
- [ ] No Production credentials in any committed file

---

## R0-2 — Provision isolation

### Staging Supabase project

Owner creates it in the dashboard. Record (never commit secrets):

| item | where it goes |
|---|---|
| staging project ref | this runbook, below |
| staging DB password | your password manager only |
| staging service role key | your password manager only |

Match Production where it matters: **region**, **PostgreSQL major 17**, SSL
enforcement enabled.

### Local PG17 rehearsal clone

Either a native PostgreSQL 17 install, or a container:

```bash
docker run -d --name phoenix-rig17 -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
```

Then point the rig at it:

```bash
PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres node tools/pg-rig/apply.mjs 147
```

CI currently uses `postgres:18`; add a **PG17 job as primary** and keep PG18 as a
non-blocking forward-compatibility job (v11 §3.4).

---

## R0-3 — Backup and restore proof

A dump is not a backup until it has been restored.

1. Owner exports a Production backup (dashboard, or `pg_dump` with the PG17
   client once the CA is pinned).
2. Record size and SHA-256. Never record the password.
3. **Restore it into the rehearsal clone** — this is the step that matters.
4. Run reconciliation against the restored copy *before* any purge:

```sql
SELECT max(version::int) FROM supabase_migrations.schema_migrations;   -- expect 147
SELECT count(*) FROM public.permission_keys;                           -- expect 130
SELECT count(*) FROM public.role_permission_defaults;                  -- expect 415
SELECT count(*) FROM auth.users WHERE lower(email)=lower('<keeper>');  -- expect 1
```

Also confirm on the restored copy, before trusting the Option-A classification:

```sql
-- Any row that is NOT part of migration 004's demo seed is a signal that real
-- operational data exists. v11 4.x fallback trigger #4.
SELECT count(*) FROM public.organizations
 WHERE id NOT IN ('00000000-0000-0000-0000-000000000001',
                  '00000000-0000-0000-0000-000000000002');
```

**Gate:** `RESTORE_PROVEN`. If the restore cannot be verified → **No-Go**, switch
to the new-Production fallback (ARCHITECTURE.md §3).

---

## R0-5 — Purge rehearsal at ceiling 147

On the restored clone only:

1. Confirm baseline 147.
2. Confirm keeper / RBAC / Storage contract for that environment.
3. Run the Option-A purge via the same runner and the same SQL SHA-256.
4. Force a deliberate failure and confirm full rollback with no partial deletion.
5. Confirm the six immutability triggers are restored byte-identically.
6. Confirm the two-session advisory-lock timeout.
7. Confirm zero business data and that migration 004's demo UUIDs are gone.

Automated equivalents already exist and must pass **on PG17**:

```bash
PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres \
  npx vitest run "ops-full-purge-v147" "ops-purge-v147-manifest-coverage" \
  --pool=forks --poolOptions.forks.singleFork
```

---

## R0-6 — Migrations 148–153 on staging

Forward-only, official mechanism, no `db reset`, no `migration repair`, no
`--include-seed`, no manual history edits.

Then prove: ceiling 153 · each version applied exactly once · no duplicates ·
functions, RLS, RBAC, ledgers, custody and reports valid.

Run the full PG17 dynamic suites; run PG18 as a non-blocking compatibility pass.

---

## R0-7 — Full-stack staging deployment

Point a Vercel Preview/Staging environment at the staging project, then verify:
keeper login · admin shell · correct zero-state · reports in zero-state · QR and
public behaviour · Auth · REST/Data API · Storage · Realtime · no critical
console or network errors.

---

## R0-8 — Go/No-Go

Record the decision in
[adr/ADR-001-purge-vs-new-production.md](adr/ADR-001-purge-vs-new-production.md).
Go for the purge path requires **all** of: restore proven · identical rehearsal
passed · PG17 parity · SSL verified · trigger restoration proved · zero
operational data confirmed · rollback and reconciliation documented · owner
approval.

Any unmet condition is a **No-Go**.

---

## R0-9 — Production execution (only after Go)

Same commit, same runner, same SQL SHA-256, same client major/minor, same CA and
checksum policy. **No modification between rehearsal and Production.** Human
password and confirmations only. No automatic retry.

---

## R0-10 — Merge, deploy, verify

Correct the PR description, mark Ready, merge at the expected head SHA, await the
Vercel Production deployment, smoke-test, take a post-cutover backup, update
STATE.md and file a HISTORY report, then close R0.

---

## Recorded environment

Fill in as provisioned; **secrets never go here**.

| item | value |
|---|---|
| staging project ref | _not yet created_ |
| staging region | _pending_ |
| staging PG version | _pending — must be 17.x_ |
| rehearsal clone | _pending — PG17_ |
| backup SHA-256 | _pending_ |
| restore proven | _pending_ |

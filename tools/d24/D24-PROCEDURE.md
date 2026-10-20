# D24 - backup and isolated restore (PostgreSQL + Storage) - procedure

Status: PROCEDURE ONLY. Nothing here runs by itself; every step against Staging or Production needs the Owner's separate authorization (phoenix-owner-gates).
The DB half reuses the method already proven three times on Staging (S2, S3a, S3b windows): `pg_dump -Fc` of `public` + every `phoenix_*` schema (+`pg_trgm`),
restore with `--exit-on-error --no-owner -L <toc without "SCHEMA - public">` into a throw-away LOCAL database, and a content fingerprint (`S2-COUNTS.sql`) that must equal the source.
Do NOT use `ops/run-pg17-restore-rehearsal.ps1` for R1: it asserts the obsolete ceiling 147 / RBAC 130-415 and relies on `trust` authentication.

## 0. STOP gates (any one stops the run, nothing is retried)
| Gate | Condition |
|---|---|
| G-ID | the connection descriptor does not name the intended project, or `pg_control_system().system_identifier` differs from the pin (Staging 7692131729119822239) |
| G-CA | TLS CA file hash differs from the pinned hash |
| G-SHA | any pinned script/SQL hash (this folder, `S2-COUNTS.sql`, the verifier) differs from the release matrix |
| G-ISO | `assertRestoreIsolation` returns any violation (see 3) |
| G-FP | restored database fingerprint differs from the source fingerprint, or the archive/manifest hashes differ from the recorded ones |
| G-ST | `storage-restore-verify.mjs` exits non-zero (missing / corrupted / extra / invalid manifest object) |
| G-OUT | the outbound probe (3.3) returns any row on the restored copy before it is neutralized and re-probed clean |

## 1. Source side (read-only on the source; Owner-authorized window)
1. DB: fingerprint (`S2-COUNTS.sql`) -> `pg_dump -Fc` -> `pg_restore --list` -> SHA-256 of the archive (record it). Stored in a restricted local folder (not Git, not a synced folder), ACL = current user only.
2. Storage manifest (database side): run `STORAGE_MANIFEST_SQL` (tools/d24/d24-lib.mjs) read-only on the source; save the JSON array `[{key, sha256}]`. Permanent objects are content-addressed
   (`permanent/{organization}/{revision}/{container_sha256}`), so the database itself is the integrity oracle for Storage.
3. Storage objects: copy bucket `central-needs-source-files`, prefix `permanent/`, with an AUTHORIZED, time-boxed read credential held only in the operator process
   (never a long-lived service-role key in a file; never printed). Only `permanent/` is evidence; `staging/` is disposable and is not backed up.
4. Record: archive sha256, fingerprint JSON sha256, manifest sha256, object count, date. Keep the DB archive and the Storage copy as two separate artifacts with separate hashes.

## 2. Restore side (isolated)
1. New local PostgreSQL 17 cluster on loopback only (`listen_addresses = 127.0.0.1`), SCRAM authentication, a throw-away database, a throw-away superuser that is not the Owner account. No `trust`.
2. Prepare like the S2 verifier (schema `extensions` with pgcrypto/uuid-ossp, role `supabase_admin`, Auth row), restore with `--exit-on-error`, recreate the auth trigger, compare the fingerprint (G-FP).
3. Storage: copy the saved objects into an empty local folder; run
   `node tools/d24/storage-restore-verify.mjs --manifest <manifest.json> --dir <folder> --db-url <loopback restore url>`
   (exit 0 only when every object re-hashes to its content address and nothing unexpected exists).

## 3. Isolation rules for the restored copy (no production connection, ever)
1. Process environment for every restore step is built clean: no `*SUPABASE*URL*`, no `*SERVICE_ROLE*`, no `PHOENIX_*PRODUCTION*`, no Production ref (`eyrzxgfkvqybjdgyphap`) anywhere. `assertRestoreIsolation` enforces this (also: loopback DB host only, local folder only).
2. The application is NOT started against the restored copy (no API, no Edge Functions, no dispatcher). Verification uses `psql` and the scripts above only.
3. Before any query that could run code, run `OUTBOUND_PROBE_SQL` on the restored copy: HTTP/cron/dblink/fdw extensions, foreign servers, subscriptions, event triggers, functions that call `net.http_*`/`dblink`. Findings are removed on the COPY only (drop the extension / disable the consumer rows),
   then the probe is repeated and must return nothing (G-OUT). Outbox consumers/events present in the dump stay unprocessed (no dispatcher exists on the copy).
4. The host firewall rule for the restore cluster port is loopback-only; the restore folder is deleted by the Owner when the proof is closed (no automatic cleanup).

## 4. Evidence (no secrets)
archive/manifest/fingerprint hashes, object counts, `storage-restore-verify` JSON line, probe result, STOP-gate outcomes, UTC dates. Stored next to the release matrix; the Director reviews it independently.

## 5. Not covered
Point-in-time recovery, Auth user passwords/secrets (Auth is a platform service; only `auth.users` evidence rows are exported), Vercel configuration. Production recovery time objective is NOT proven by a Staging rehearsal alone.

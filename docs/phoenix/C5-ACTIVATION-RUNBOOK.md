# C5 activation runbook — the ordered window around M217

This runbook implements C5 contract v1.9 §2 and §21, with the Owner hardening
H1–H13, for applying
`supabase/migrations/217_phoenix_central_needs_c5_safety_convergence.sql`.
It covers the freeze, drain, governed rejection, proofs and restore that must
surround M217. M217 itself is still applied only by the pinned executor
(`.github/workflows/apply-production-migration.yml`).

> **Production activation is NOT authorized.** The tooling defaults to a
> loopback rehearsal and refuses every other target unless all three hold:
> `--target=production`, the pinned project ref, and the exact authorization
> phrase. The phrase is issued only with a separate, explicit Owner Production
> authorization. The freeze and restore DCL are Production mutations (§2.6).
> Nothing in this document grants a gate. Governance precedence is the same
> as in [OPERATIONS.md](OPERATIONS.md).

| Piece | Where it lives |
|---|---|
| Pure decisions: every refusal, HOLD, WAIT and PASS | `tools/phoenix-demo/c5-activation-contract.mjs` |
| The SQL it runs: reads only, plus the ONE governed reject RPC call (`REJECT_RPC_SQL`) | `tools/phoenix-demo/c5-activation-sql.mjs` |
| CLI: phases, sealed evidence, the attempt ledger | `tools/phoenix-demo/c5-activation-runbook.mjs` |
| Unit matrix (no database) | `tools/phoenix-demo/__tests__/c5-activation-contract.test.ts` |
| Loopback rehearsal, including the attacks and the B2 negative controls | `supabase/migrations/__tests__/217-central-needs-c5-activation-rehearsal.dynamic.test.ts` |

The freeze and restore DCL are generated from sealed ACL snapshots by the
contract (`planFreezeStatements`, `planRestoreStatements`); they are not SQL
constants and never come from operator input.

---

## 1. Roles

| Role | Requirement | Checked |
|---|---|---|
| **Runner.** Every §2 read and both DCL transactions run as this role. | `(rolsuper OR rolbypassrls) AND (rolsuper OR pg_read_all_stats)`, and the same `current_user`/`session_user` for every read (H1). | Before T0, then again at the start of every phase and on every key read. |
| **Governed rejection operator.** Named by profile uuid in `PHOENIX_C5_REJECT_OPERATOR_ID`. | Active profile with role `super_admin` or `central_warehouse_manager`, and `central_needs.approve`. Unless super_admin, belongs to the owner organization of every submitted revision. Every owner organization exists and is not archived. `authenticated` keeps EXECUTE on reject (H7). | At preflight; again immediately before T0 (in the `freeze` invocation); and against S0 ∪ S1 before any rejection. |
| **Release operator.** Runs the phases and dispatches the executor. | Reads the executor run and passes its **terminal state** to `post-apply` and to any `stop` after READY_FOR_M217 (`--executor-run-id`, `--executor-conclusion`). | Sealed in the evidence of the phase that uses it. |
| **Owner** | Authorizes Production, dispositions every earlier attempt (H3), records the ledger anchor, reviews any CASCADE path, and decides every HOLD exit. | — |

Production has **not** attested that its `postgres` role is a member of
`pg_read_all_stats`. If it is not, the runner refuses before T0
(`RUNNER_CANNOT_SEE_ALL_SESSIONS`). It never proceeds on a drain that may be
blind.

## 2. The ordered sequence

Each CLI invocation runs one phase. The steps inside a phase follow
`ACTIVATION_STEPS` strictly. A skipped or repeated step is refused
(`STEP_OUT_OF_ORDER`).

| Phase | Steps (contract §, hardening) | Mutates? |
|---|---|---|
| `preflight` | The **ledger anchor** is read first: the database identity (name, oid, cluster system identifier when readable) and the SHA-256 of the evidence root (D-09). **HISTORY_ATTESTED**, H12: fresh history read as text and reconciled. Ceiling must be exactly 216. The row reconciled to canonical 216 must be the sealed dispatch row `20260924124100 / 216_phoenix_central_needs_region_persistence`, and the local 216 file must hash to the sealed SHA-256. The executor inputs are validated: filename, SHA-256 of the local M217 bytes, 216 → 217, and a `remote_history_version` strictly newer than the freshest row. **RUNNER_ATTESTED**, H1. **OPERATOR_ATTESTED**, H7, plus a read-only census of roles that could write lifecycle or audit rows directly (H11). **PRIOR_ATTEMPTS_DISPOSITIONED**, H3 (§5). The preflight time is sealed from the database clock. | No |
| `freeze` | Immediately before T0, in the same invocation (D-05): the preflight must be at most **15 minutes** old (database clock), the history attestation is re-read and must equal the sealed one exactly, and the operator is re-checked against every currently submitted revision. Any failure is `REFUSED_BEFORE_T0` with nothing frozen. **T0_SNAPSHOT_SEALED**, §2.1: ONE statement returning T0, S0, the widened A0 `(id,status,plan_id,organization_id,revision_number,approved_by,approved_at,updated_at)`, the submit/approve ACL0 and the reject ACL (H8 tuples from `aclexplode(COALESCE(proacl, acldefault('f', proowner)))`), the lifecycle-audit census L0, **session-independent fingerprints of every body M217 replaces plus submit and reject** (D-02), and the runner. The captured ACL then passes the **ledger gate** (§5, D-03) and the H8 assessment: a grantor that is not the owner, or any grant option, is a HOLD before any DCL unless the Owner-reviewed path `--reviewed-cascade=<Owner review reference>` was chosen (D-11: a bare flag is refused, the reference is sealed). **ACL_FROZEN**, §2.2: the planned frozen set (the owner's own tuples) and a write-ahead `freeze_committed: 'unknown'` are persisted; then ONE DCL transaction with `lock_timeout 5s` reconfirms ACL == ACL0, revokes EXECUTE from every captured non-owner grantee, then from `authenticated, service_role, anon, PUBLIC` explicitly, **verifies inside the transaction that the result is exactly the planned frozen set** (else ROLLBACK), and commits. The commit is persisted at once; F0 is read on the same connection. The frozen ACL is sealed and verified. | DCL |
| `resolve` (re-runnable) | **DRAIN_1_PASSED**, §2.3/H2: zero older-than-F0 client transactions (the exact §2.3 SQL), zero `<insufficient privilege>` sessions (no `backend_type` filter), and zero `pg_prepared_xacts` for this database. **S1_ENUMERATED**. **SUBMITTED_RESOLVED**, §2.4/H6: every id in S0 ∪ S1 goes through the canonical reject RPC AS the operator. An id already `rejected` with canonical reject evidence written by the same transaction (equal xmin) counts as resolved. Any other status is a STOP. **ZERO_SUBMITTED_PROVEN**, then **DRAIN_2_PASSED**. **READY_FOR_M217** (§21.8), all collected: zero submitted; M217 **proven** absent (history, catalog, every body identical to its T0 fingerprint, no in-flight M217 backend); the ACL still exactly the frozen ACL; and **Proof A, Proof B and the lifecycle-audit census as they stand now** — so an accounting violation is a STOP before M217, never a post-apply HOLD with M217 already committed. | Governed rejects only |
| (executor) | The pinned executor applies **M217 DATABASE FIRST**. This tool only gates and records. | Migration |
| `post-apply` | Needs `--executor-run-id=<id> --executor-conclusion=<success\|failure\|cancelled>`. **M217_OUTCOME_CLASSIFIED**, H9 (§4). **POST_APPLY_VERIFIED**, H10 (§3). **PRE_RESTORE_ZERO_SUBMITTED**, a re-read immediately before the restore. **ACL_RESTORED**, §2.6: ONE DCL transaction. It runs only if the ACL is still exactly the frozen set, re-grants exactly ACL0 (grants made by a grant-option holder are re-issued as that grantor), and **commits only if the result inside the transaction is exactly ACL0** (D-07; otherwise ROLLBACK, the freeze stays). It never guesses or defaults a grant. **RESTORE_VERIFIED**: the restored set, the unchanged reject ACL and the operator capability. **Re-entrant** (D-08): a read error after the classification leaves the attempt open; re-running `post-apply` re-classifies (a committed M217 cannot "disappear") and continues. | DCL |
| `stop` | An operator STOP. See §4. After READY_FOR_M217 it needs `--executor-conclusion=not_dispatched\|failure\|cancelled` (plus `--executor-run-id` unless never dispatched). | DCL (restore) only when non-commit is proven |

`freeze` is re-runnable after a failure **after** its COMMIT: the commit is
already recorded, so a re-run resumes from catalog truth (D-03) instead of
leaving an attempt that believes nothing was frozen.

`resolve` returns **DRAIN_WAIT** (exit code 2) when an older transaction or a
prepared transaction is still live. The freeze stays in place, and you re-run
`resolve` later. Terminating a backend, or resolving a prepared transaction,
needs a separately recorded operator decision; the tool never does either.
A hidden session is not a WAIT, it is a **HOLD**: the runner cannot see what
it is required to prove absent.

**The gap before M217.** The last drain in `resolve` and the executor's apply
are separated by a manual dispatch with an environment approval. M217's
`NOWAIT` lock pair and its zero-submitted precondition backstop that gap. The
post-apply drain and Proof A/B then catch anything that straddled it. Keep the
gap as short as possible, and never run `post-apply` or `stop` while the
executor run is still queued or running: pass its **terminal** state.

**Preconditions this tool cannot pre-check.** Before M217 its classifier and
lineage helper do not exist. Two of M217's own preconditions therefore cannot
be pre-read: zero DRAFT invalid source evidence and zero DRAFT unsafe lineage
links. If M217 refuses on either, it rolls back and `post-apply` classifies
the outcome (§4).

## 3. Post-apply verification (H10) — all collected, any failure is a HOLD

- **M217 identity.** The history row for the pinned `remote_history_version`
  exists exactly once, named `217_phoenix_central_needs_c5_safety_convergence`.
  The reconciled ceiling is 217, and the row count is the attested count + 1.
  The attested 216 row is unchanged. The local M217 bytes still hash to the
  pinned SHA-256.
- **Exact overloads.** Each governed function name exists exactly once.
- **Classifier.** IMMUTABLE, CALLED ON NULL INPUT, invoker, search_path pinned.
  EXECUTE for authenticated and service_role; none for anon or PUBLIC.
- **Lineage helper and fence function.** Definer, search_path pinned, no
  client EXECUTE.
- **Fence trigger.** `BEFORE INSERT OR UPDATE ... FOR EACH ROW`, no column
  list, enabled.
- **Source CHECK.** Present and `NOT VALID`.
- **Readiness blockers.** The vocabulary carries both new C5 blocker codes.
- **Replaced bodies.** Every replaced body carries its C5 marker.
- **Zero states.** Zero submitted, zero pre-F0 transactions, zero hidden
  sessions, zero prepared transactions. Every S0 ∪ S1 id is still
  governed-rejected.
- **Proof A** (H4). The lifecycle-state delta from A0, in both directions,
  expected **EMPTY**. Every delta is classified as approval, supersede,
  demotion, deletion, re_parent or round_trip, and annotated with its audit
  evidence.
- **Proof B** (H5). Approve and gate audits at or after T0, expected
  **EMPTY**. Each one is classified by a physical same-transaction check:
  equal xmin, equal `created_at`, and the gate's `txid` mod 2³² = xmin. A
  payload match alone is never evidence.
- **Lifecycle-audit census** (H11). Since T0 the submit, approve, gate,
  supersede and reject audit rows may change only by one reject per governed
  id, plus the submit audit of an S1 revision that straddled T0. Any other
  addition, any removal and any edited row is a HOLD.
- **Lifecycle writers.** Only submit, approve and reject UPDATE
  `plan_revisions.status`. Only the two openers INSERT revisions.
- **ACLs.** The submit/approve ACL still equals the sealed frozen ACL (M217 is
  ACL-neutral). The reject ACL still equals its T0 snapshot. The rehearsal
  proves this check refuses both B2 negative controls — a `DROP FUNCTION`
  approve + `CREATE` (default privileges bring `service_role` back) and a
  blanket `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public` — when a variant
  slips past M217's own VERIFY (which refuses both before COMMIT).

**H13 / §12 DRAFT audit.** This audit is sealed with the evidence. It covers:

- chronology ambiguity: on DRAFT revisions, two or more overrides of one
  source record that share `created_at`, or that were queued at or after T0;
- lineage links pinned to a non-head override. `required_pin` marks
  ambiguous or not_numeric evidence; for native or canonical-integer evidence
  the pin is informational;
- unsafe lineage links;
- invalid source evidence.

The rehearsal runs every one of these audits against seeded non-empty data
(TR-5). These findings keep the **affected DRAFT workflow** on HOLD until a
governed repin or review. The readiness blockers enforce that from M217
onwards. They do not hold the activation, and the conclusion lists them as
`draft_workflow_holds`.

## 4. Failure branches — never repaired by direct edits

Every C5_ACTIVATION_HOLD after T0 records `freeze_in_place` from **catalog
truth at the moment of concluding** (D-03), never from what a transaction was
believed to do: `true` only when the live ACL is the frozen set, `false` only
when it is the restoration-target ACL0, `'UNKNOWN'` otherwise (or when the ACL
cannot be read). `freeze_state` and `acl_at_conclusion` are sealed with it.

| Situation | Decision |
|---|---|
| Refusal before T0 (H12/H1/H7/H3, the D-05 re-check, the ledger anchor) | `REFUSED_BEFORE_T0`. Nothing was frozen. |
| The captured ACL fails the ledger gate (§5), carries a non-owner grantor or a grant option without a referenced CASCADE review, or does not let `authenticated` execute submit and approve | `C5_ACTIVATION_HOLD` at `ACL0_ASSESSMENT`. No DCL ran. |
| The freeze transaction rolled back, or its COMMIT reply / a post-COMMIT read was lost | Catalog truth decides: ACL == ACL0 → HOLD, not frozen; ACL == the planned frozen set → the freeze **is** in place: recorded, and the attempt continues (a re-run of `freeze` resumes); anything else → HOLD, `freeze_in_place: 'UNKNOWN'`. |
| A STOP (drain HOLD, a resolution STOP, remaining submitted, a failed READY precondition, or `--phase=stop`) | **C5_ACTIVATION_HOLD** (H3). Proof A/B and the census run against **this attempt's own T0/A0/L0** and are sealed. ACL0 is restored **only when M217 non-commit is PROVEN** (D-01/D-02): no history row, every M217 object absent, every replaced body identical to its T0 fingerprint (the pre-C5 approve included), no in-flight M217 backend (no other backend or prepared transaction holding or awaiting a ShareLock-or-stronger lock on either §1 relation, no open transaction running M217 text, no hidden session), the history still the attested count, and — once READY_FOR_M217 exists — the executor's terminal non-success state; and only when catalog truth shows the freeze in place. Otherwise nothing is restored. |
| A STOP at or after READY_FOR_M217 that finds M217 (partly) present | **Refused** (`STOP_M217_PRESENT`): nothing is restored, the attempt stays open with the freeze kept. Run `post-apply`. |
| A STOP whose non-commit is not proven (e.g. no executor terminal state, a live M217 lock) | HOLD `STOP_M217_NON_COMMIT_UNPROVEN`, the reasons listed, nothing restored, the freeze kept. |
| M217 **FAILED_CLEAN**: the catalog shows M217 absent AND the full non-commit proof above holds, with the executor's terminal state `failure` or `cancelled` (H9) | Non-commit is established, so ACL0 is restored (verified before COMMIT). HOLD. |
| M217 **FAILED_PARTIAL** or **UNKNOWN** (including "absent but not proven") | The freeze stays in place, **nothing is restored**, HOLD. Escalate as in [OPERATIONS.md §3](OPERATIONS.md). |
| Any H10 failure after a committed M217, or submitted revisions at the pre-restore re-read | The freeze stays in place, nothing is restored, HOLD with the exact revision, audit and state evidence. |
| A restore whose in-transaction result is not exactly ACL0 | ROLLBACK; the frozen set stays; HOLD with the unexpected and missing tuples. |
| Any restore justified by FAILED_CLEAN (a STOP or `post-apply`) | The non-commit proof reads the in-flight check **before and after** the history/catalog reads, both must be empty (A-01). The restore transaction then takes `ACCESS SHARE NOWAIT` on `central_needs_source_records` (M217's first lock is ACCESS EXCLUSIVE, so no M217 can commit while it is held) and **re-proves non-commit inside the transaction** before any GRANT. An M217 found in flight or present there rolls the restore back: `M217_PRESENT_AT_RESTORE` (post-apply) / `STOP_M217_PRESENT` (a STOP after READY_FOR_M217). Nothing is restored, the freeze is kept, the attempt stays open; re-run `post-apply`. |
| `post-apply` with `--executor-conclusion=not_dispatched` | Refused (`POST_APPLY_REQUIRES_EXECUTOR_RUN`, A-05): post-apply classifies what an executor run did. A never-dispatched executor is a `stop` matter. |

§21.12 applies throughout: never repair by a direct status edit, an audit
deletion, backdating or a synthetic gate.

**H11.** Direct DML on `central_needs_plan_revisions` or `audit_logs` by
`service_role`, a BYPASSRLS role or any table writer is **prohibited from T0
until the restore**. The only exception is the governed procedure itself.
The preflight records which roles could do it. Proof A, Proof B and the census
detect it — before M217 at READY_FOR_M217, and again after it. After M217 the
fence refuses a direct approve.

**D-10 — a straddler rejected by a reviewer is a STOP, by design.** A submit
that passed its EXECUTE check before F0 and commits after T0 lands in S1 and
is governed-rejected. If an ordinary reviewer rejects it BEFORE S1 is
enumerated (reject is never frozen), it is in neither S0 nor S1, so its
submit and reject audits are unexpected to the census. The census is **not**
relaxed for that shape: admitting "a post-T0 submit plus a post-T0 reject of
a rejected revision" would equally admit the same pair forged by a privileged
writer with a direct status edit (H11). Because the census is a READY
precondition, the case surfaces as a **STOP before M217** (exact ACL0
restored) whose census evidence names the revision under `straddler_pattern`;
the next attempt acknowledges those audit ids in its disposition. Keep the UI
read-only during the window and re-run `resolve` promptly after a DRAIN_WAIT.

## 5. Evidence, the attempt ledger and dispositions (H3)

`--evidence-dir` must be **outside the repository**. Each attempt gets
`attempt-NNN-<UTC>/`, which holds:

- numbered JSON files, one per step;
- `attempt-state.json`;
- `SHA256SUMS.txt`, in sha256sum binary format (`<hex> *./<file>`).

The manifest is re-verified at the start of every phase; a mismatch is
`EVIDENCE_TAMPERED`. Evidence text containing a connection-string pattern is
refused. Each attempt records every earlier attempt with its manifest
SHA-256, so a vanished attempt breaks the chain (`PRIOR_ATTEMPT_CHAIN_BROKEN`).

**The ledger is bound (D-09).** Every attempt seals a ledger anchor: the
database identity and the SHA-256 of the normalized evidence root. A new
attempt is refused if any earlier attempt was taken against another database
(`LEDGER_DATABASE_MISMATCH`) or sealed under another root
(`LEDGER_ROOT_MISMATCH`); an earlier attempt with a T0 but no anchor is
refused too (`LEDGER_ANCHOR_MISSING`). The preflight prints the ledger digest:
SHA-256 of `c5-activation-ledger v1`, the database identity, and one line
`<attempt_id> <manifest sha256>` per earlier attempt
(`ledgerDigestInput`). **Production requires the Owner-recorded anchor**
(`--expected-prior-attempts` and `--expected-ledger-sha256`, or
`PHOENIX_C5_EXPECTED_PRIOR_ATTEMPTS` / `PHOENIX_C5_EXPECTED_LEDGER_SHA256`,
taken from the release record); without it the preflight is refused
(`LEDGER_ANCHOR_REQUIRED`), and a mismatch is `LEDGER_ANCHOR_MISMATCH`. This is
what makes a retry from a fresh, empty evidence directory visible.

A new attempt is refused when:

- An earlier non-PASS attempt that had a T0 is not dispositioned
  (`PRIOR_ATTEMPT_UNDISPOSITIONED`).
- Its disposition does not acknowledge **exactly** the revision deltas
  measured now against that attempt's own T0/A0 through Proof A and Proof B
  (`acknowledged_delta_ids`, else `PRIOR_ATTEMPT_DELTA_UNDISPOSITIONED`), and
  **exactly** the audit-row ids its lifecycle-audit census reports against its
  own L0 — every removed, edited or unexpectedly added submit/approve/gate/
  supersede/reject audit (`acknowledged_audit_ids`, else
  `PRIOR_ATTEMPT_AUDIT_DELTA_UNDISPOSITIONED`). These rules stop a fresh T0
  from laundering a delta.
- An earlier attempt never concluded (`PRIOR_ATTEMPT_UNCONCLUDED`). STOP it
  first.
- The LAST earlier attempt with a T0 left the freeze in place or uncertain —
  any `freeze_in_place` other than exactly `false` — and its disposition sets
  neither `carry_forward_acl0: true` nor `acl_rebaseline: true`
  (`PRIOR_ATTEMPT_FREEZE_UNRESOLVED`; both at once is
  `PRIOR_ATTEMPT_DISPOSITION_CONFLICT`).

**The T0 ledger gate (D-03): a frozen ACL is never captured as ACL0.** The
ACL captured at T0 must be a known ledger state:

| Last earlier attempt with a T0 | Captured ACL accepted | Restoration target |
|---|---|---|
| none | any ACL that lets `authenticated` execute submit and approve | the captured ACL |
| freeze not in place | exactly that attempt's ACL0; anything else only with `acl_rebaseline` (never its frozen set: `ACL0_IS_FROZEN_SET`, else `ACL0_NOT_IN_LEDGER`) | the captured ACL |
| freeze in place or uncertain | its frozen set with `carry_forward_acl0` (the ACL0 is carried forward through the ledger, attempt after attempt); its ACL0 as-is; anything else only with `acl_rebaseline` (else `PRIOR_FROZEN_ACL_CHANGED`) | the carried ACL0, or the captured ACL |

Whatever the basis, the restoration target must let `authenticated` execute
submit and approve (`ACL0_LACKS_CLIENT_EXECUTE`). An attempt whose gate
refused carries the ledger's known ACL0 forward unchanged, never the ACL it
happened to capture.

Dispositions file (`--dispositions=<file>`), one entry per earlier non-PASS
attempt with a T0:

```json
[{ "attempt_id": "attempt-001-20260926T101500Z", "decision": "retry after grant review",
   "owner_reference": "<Owner decision reference>",
   "acknowledged_delta_ids": ["<revision uuid>"],
   "acknowledged_audit_ids": ["<audit_logs uuid>"],
   "carry_forward_acl0": false, "acl_rebaseline": false }]
```

## 6. Running it

Loopback rehearsal of the database side, which is the only authorized use:

```bash
PHOENIX_RIG_PG=postgresql://postgres@127.0.0.1:<port>/postgres PHOENIX_RIG_DB=<unique> \
  npx vitest run supabase/migrations/__tests__/217-central-needs-c5-activation-rehearsal.dynamic.test.ts \
  --fileParallelism=false --pool=forks --maxWorkers=1 --isolate=false --hookTimeout=600000 --testTimeout=300000
```

Set `PHOENIX_C5_REHEARSAL_EVIDENCE_DIR=<dir outside the repo>` to keep the
sealed evidence of every rehearsal attempt. The prepared-transaction case (R6)
needs a server with `max_prepared_transactions > 0`; where it is 0 (the
default, e.g. a stock CI service container) R6 is **skipped with a recorded
reason** instead of failing, and the prepared-transaction drain decision stays
covered by the unit matrix.

CLI against a loopback database:

```bash
PHOENIX_C5_ACTIVATION_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/<db> \
PHOENIX_C5_REJECT_OPERATOR_ID=<profile uuid> \
PHOENIX_MIGRATION_FILENAME=217_phoenix_central_needs_c5_safety_convergence.sql \
PHOENIX_MIGRATION_SHA256=<sha256 of the reviewed file> \
PHOENIX_EXPECTED_CURRENT_CEILING=216 PHOENIX_EXPECTED_NEXT_CEILING=217 \
PHOENIX_REMOTE_HISTORY_VERSION=<fresh 14-digit UTC, newer than every applied row> \
  node tools/phoenix-demo/c5-activation-runbook.mjs --phase=preflight --evidence-dir=<dir outside the repo>
# then --phase=freeze (within 15 minutes), --phase=resolve (repeat while it WAITs), [M217],
# --phase=post-apply --executor-run-id=<run id> --executor-conclusion=<success|failure|cancelled>
```

A rehearsal URL must be a loopback `postgres://` / `postgresql://` URL; a query
parameter that overrides the host, hostaddr, port or service is refused, and
the host the driver will actually resolve must be loopback (D-06).

A Production URL (`--target=production`, after the authorization phrase and the
lexical project-ref check) is bound to the target the DRIVER will use (DIR-01),
before anything connects:

- only `postgres://` or `postgresql://` (`PRODUCTION_TARGET_PROTOCOL`);
- no redirect-capable query key, whatever its case (`PRODUCTION_TARGET_REDIRECT`):
  `host`, `hostaddr`, `port`, `service`, `servicefile` (the keys shared with
  the rehearsal), plus `user` and `options`, which pick the tenant on the
  Supabase pooler, and `replication`, which would open a walsender session;
- the string `buildRemoteIo` hands to `pg` is parsed with pg-connection-string,
  and the effective host and user must be the pinned project's: `db.<ref>.supabase.co`,
  or a `*.pooler.supabase.com` host with the user `<role>.<ref>`
  (`PRODUCTION_TARGET_NOT_PINNED`);
- an explicit port of 5432 or 6543, so `PGPORT` never applies, and the database
  `postgres` (`PRODUCTION_TARGET_SHAPE`);
- `PGOPTIONS` and `PGREPLICATION` unset in the runner's environment
  (`PRODUCTION_TARGET_ENVIRONMENT`), because pg falls back to them for the
  refused `options` and `replication` keys.

`sslmode` and the other `ssl*` keys, `application_name` and timeouts are accepted.
A refusal names the offending query key or variable, never a value. An unknown
`--target` value or an unrecognized argument is refused without being echoed.
Confirm that the Production secret carries an explicit `:5432` (or `:6543`) and
`/postgres`. The standard Supabase strings do, and a string without them is
refused before anything connects.

Exit codes: `0` for PREFLIGHT_PASS, FROZEN, READY_FOR_M217 or
C5_ACTIVATION_PASS. `1` for a refusal or C5_ACTIVATION_HOLD
(`::error::[code] …`). `2` for DRAIN_WAIT. When `GITHUB_OUTPUT` is set, the
tool writes `c5_activation_outcome` and `c5_activation_attempt` to it.

## 7. §21 steps this tool does not perform

- **Before T0:** put the UI into maintenance or read-only mode. This is for
  UX only; correctness does not depend on it (§2.2).
- **After the restore:** deploy the reviewed UI companion, which is §21.15.
  Merging to `master` auto-deploys the UI (OPERATIONS §4), so the UI
  companion must not reach `master` before M217 has been applied and the
  activation has passed.
- **Then:** run the focused product smoke test and require clients to reload
  (§21.16–17).

## 8. Known limitations

- The Production path, `--target=production`, is implemented but has never
  been exercised. It uses the executor's redacting I/O adapter, whose TLS
  configuration is `rejectUnauthorized: false` (see OPERATIONS §8).
- M217 content identity is the sealed-SHA local bytes plus the fresh version
  and name (H12). `schema_migrations.statements` is deliberately not treated
  as an identity source.
- The executor's terminal state is an operator input read from the executor
  run; the tool cannot query GitHub. It is sealed, and it is only ever one
  part of the non-commit proof, never sufficient on its own.
- Evidence written by an earlier revision of this tool (no ledger anchor, no
  body fingerprints) is not accepted as a prior attempt with a T0; such an
  attempt needs an Owner decision outside the tool.
- The D-10 straddler shape is fail-closed by design (§4): it costs a STOP and
  a retry, never a silent seal.

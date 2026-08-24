# MediStock Phoenix — Operational Readiness

Stage I / I-7. One place for how this system is operated, recovered and
released. It records **only what is provable from this repository or from
verified live evidence**. Where a capability cannot be proven, it says so and
names the exact missing evidence rather than describing an intention as a fact.

Governance precedence is unchanged: the current owner task, then
`.claude/skills/phoenix-owner-gates`, then
`.claude/skills/phoenix-protected-state-policy`, then repository convention.
Nothing here grants an authorization gate.

---

## 1. Readiness summary

| Area | Status | Where it lives |
|---|---|---|
| Production migration executor | **PROVEN** | `.github/workflows/apply-production-migration.yml` |
| Migration failure classification | **PROVEN** | executor, final step |
| Migration history reconciliation | **PROVEN** | `tools/phoenix-demo/production-migration-history.mjs` |
| Required merge gates | **PROVEN** | ruleset `21216543`, 4 required checks |
| Authenticated acceptance | **PROVEN** | `.github/workflows/e2e-authenticated.yml` |
| Windows release-engine acceptance | **PROVEN** | `.github/workflows/ops-windows-acceptance.yml` |
| Operational access boundaries | **PROVEN** | migration 187, owner-gates skill |
| Audit trail | **PARTIAL** | `audit_logs` relation; no retention policy recorded |
| Deployment + rollback | **PARTIAL** | §4 below; Vercel-native |
| Post-deployment verification | **PARTIAL** | §5 below |
| Monitoring / alerting | **MISSING** | no external monitor is configured or evidenced |
| Backup posture | **EXTERNAL_PLATFORM_EVIDENCE_REQUIRED** | §7 |
| Restore evidence | **MISSING** | §7 — no rehearsal has ever run |
| Secret rotation | **PARTIAL** | §8 |
| Emergency contacts / ownership | **OWNER_DECISION_REQUIRED** | §9 |
| RPO | **OWNER_DECISION_REQUIRED** | §7 |
| RTO | **OWNER_DECISION_REQUIRED** | §7 |

---

## 2. Incident severity and stop conditions

| Sev | Meaning | Response |
|---|---|---|
| **S1** | Production data is wrong, exposed, or lost. Includes any suspected privilege escalation, cross-organization data leak, or duplicated/again-posted ledger movement. | Stop all release activity. Capture evidence (§10) before changing anything. |
| **S2** | Production is up but a critical corridor is unusable — dispatch, receive, return, or the anonymous QR portal. | Stop releases. Diagnose read-only first. |
| **S3** | Degraded but with a workaround; no data integrity risk. | Normal fix-forward through a PR. |
| **S4** | Cosmetic or documentation. | Normal queue. |

**Hard stop conditions.** Halt and escalate rather than proceeding, for any of:

* a Production migration run whose outcome is **partial or ambiguous**;
* Production migration history that does not reconcile;
* a security-contract regression (PUBLIC EXECUTE, RLS, policy, or ACL drift);
* credentials that behave inconsistently between two runs;
* any situation where the fix requires rewriting an applied migration.

**Never**, in any severity: retry an ambiguous Production apply, hand-repair
Production schema, apply migrations by an alternate transport, force-push, or
rewrite merged history. Those are the failure modes that turn one incident into
two.

---

## 3. Production migration failure response

The executor is the **only** authorized route to apply a migration to
Production. It refuses to accept SQL, a script path, a project ref, a version
range, or `--include-all`, and it proves the pending set is exactly one
migration **twice, independently**, before it writes anything.

Its final step classifies a failure. Use that classification; do not improvise.

| Classification | Meaning | Action |
|---|---|---|
| **FAILED_CLEAN** | Ceiling unchanged and the migration's objects are absent. | Safe. Fix the cause in a PR, then dispatch once more. |
| **FAILED_PARTIAL** | Objects exist wholly or partly but the history row does not (or the reverse). | **STOP.** Escalate. No retry, no repair, no correction migration until adjudicated. |
| **AMBIGUOUS** | Anything else, including an unreadable history. | **STOP.** Escalate. Treat as FAILED_PARTIAL until proven otherwise. |

Reading the classification is a read-only act. Proving which one applies is
done with read-only queries against Production migration history and the
migration's own objects — never by re-running the executor to "see what
happens".

**Precedent worth keeping.** A dispatch that refuses inside the read-only
preflight is FAILED_CLEAN by construction: the apply step is skipped, and
`supabase db push` is never invoked in any form. That has happened and was
correctly classified; it is the expected shape of a safe refusal.

### Forward-only correction

Applied migrations are immutable. A defect in an applied migration is corrected
by a **new** migration, never by editing the applied one. M001–M198 are
currently applied and immutable.

---

## 4. Application deployment and rollback

Deployment is Vercel-native: merging to `master` builds and promotes. There is
no separate deploy command, and `vercel --prod` must not be used directly.

**Rollback decision tree.**

1. **Is Production data at risk right now?**
   Yes → S1. Stop. Evidence first (§10). Application rollback does not undo a
   database change; do not assume it will.
2. **Did the regression arrive with the most recent deploy, and is the previous
   deployment still healthy?**
   Yes → promote the previous Vercel deployment. This is the fastest safe
   action and touches no database state.
3. **Does the fix require a schema change?**
   Yes → it is forward-only through the executor (§3). Never roll a migration
   back.
4. **Otherwise** → fix forward through a normal PR with the four required
   checks.

**A frontend rollback never reverts a migration.** If a deploy and a migration
landed together, rolling back the frontend leaves the newer schema in place.
That is usually safe — this repository's migrations are additive or
privilege-only — but it must be verified, not assumed.

---

## 5. Post-deployment verification

After any Production-affecting change, verify read-only:

* migration ceiling is exactly what was intended, and the target row appears
  exactly once with the expected name;
* nothing is pending;
* the Major-H authorization invariants still hold — the executor asserts these
  automatically on every apply;
* first-party SECURITY DEFINER routines carry **no PUBLIC EXECUTE**;
* the anonymous QR portal answers for a known-good public id;
* an authenticated session resolves its organization and role.

The executor performs the migration-history and authorization-invariant checks
itself and fails the run if any of them regress. The product-surface checks are
manual and read-only.

---

## 6. Merge gates

Ruleset `21216543` ("Phoenix Master Production Gate") is `active` on
`refs/heads/master` with **zero bypass actors**, and requires:

1. `Security and quality gates`
2. `PostgreSQL pg-rig`
3. `Vercel`
4. `Authenticated browser acceptance (disposable local Supabase)`

plus pull-request review-thread resolution, non-fast-forward protection and
deletion protection.

**A required status check must be unconditional.** GitHub blocks a pull request
whose required context never arrives, and repository rulesets have no
conditional or path-scoped form of `required_status_checks`. The authenticated
acceptance workflow therefore carries **no `paths:` filter**;
`tests/e2e-authenticated-trigger-contract.test.ts` fails if one is
reintroduced. Do not add a path-filtered workflow to the required set.

> Pull requests opened **before** a change to a required workflow's triggers do
> not carry the new context until they are re-triggered by a push or an
> "Update branch". This is expected, and is resolved by updating the branch.

---

## 7. Backup, restore, RPO and RTO

**This section deliberately claims nothing.**

* **Backup posture — EXTERNAL_PLATFORM_EVIDENCE_REQUIRED.** Whatever automated
  backups exist are a property of the Supabase project, not of this repository.
  Nothing in this repository proves that backups are enabled, what their
  retention is, or whether point-in-time recovery is available. **Do not state
  that PITR or any retention window exists** until platform evidence is
  recorded here.
* **Restore evidence — MISSING.** `ops/` contains a real restore-rehearsal
  engine (`run-pg17-restore-rehearsal.ps1` → `restore-run-result.json` →
  `generate-restore-proof.ps1`) which restores a backup onto a **local,
  disposable, loopback PostgreSQL 17 clone** and extracts every field from real
  commands. It accepts no boolean, exit code or version as an input.
  `ops/evidence/README.md` records that **no rehearsal has ever run and none of
  the evidence files exist**. Therefore restore capability is *unproven*, not
  *absent* — the tooling is ready and has never been exercised.
* **RPO — OWNER_DECISION_REQUIRED.** No recovery point objective has been set.
* **RTO — OWNER_DECISION_REQUIRED.** No recovery time objective has been set.

A restore rehearsal against a disposable local clone is safe and is the
preferred way to close this gap. **A destructive restore exercise against
Production is forbidden.** No paid platform feature may be enabled without
separate cost authorization.

---

## 8. Secrets and credential rotation

* The Production database URL reaches CI **only** as the repository secret
  `PHOENIX_PRODUCTION_DATABASE_URL`, consumed by the executor. It is never
  echoed: `tools/pg-rig/remote-io.mjs` redacts connection strings out of
  connection errors, and no executor script interpolates it into a message.
* `service_role` must never appear in any `VITE_`-prefixed variable or anywhere
  the browser bundle can read. Only `VITE_PHOENIX_SUPABASE_URL` and
  `VITE_PHOENIX_SUPABASE_ANON_KEY` are exposed to the frontend.
* **Rotation is owner-performed.** An agent must not read, set, or rotate a live
  secret. When a credential is suspected stale, diagnose by emitting
  **booleans only** — never the value. A structure diagnostic of exactly this
  shape (protocol, username form, host, port, path, whitespace, encoding
  round-trip) has previously distinguished a malformed URI from a wrong
  password without ever exposing either.
* After rotation, the executor's read-only preflight is the cheapest proof that
  the new credential works: it authenticates and reports, and cannot mutate.

---

## 9. Ownership and escalation

**OWNER_DECISION_REQUIRED.** This repository defines no on-call rota, no
escalation contacts and no ownership matrix, and none can be invented here.

What *is* established: the owner is the final authority for every gate;
ChatGPT acts as the control and adjudication layer; the execution plane never
crosses a gate the current task has not opened. Production authorization is
granted per task and is never inherited.

---

## 10. Evidence capture

Before changing anything during an incident, capture:

* the exact workflow run id and job id, and its step-by-step conclusions;
* the failing step's log — **in full**, not tailed; a truncated log routinely
  discards the one line that identifies the cause;
* live migration history: version and name, read as text, never cast to an
  integer;
* the live ruleset, and the PR's check contexts;
* for a suspected data issue, the affected rows read-only, with their audit
  trail.

A check that did not run is recorded as **not run** — never as a pass. A skipped
test is not a pass. A workflow that did not emit is not a pass.

---

## 11. Go / No-Go checklist

Every line must be **yes** before a Production-affecting release.

- [ ] Live `master` SHA and tree verified against what was reviewed.
- [ ] All four required checks terminal green on the exact merge commit.
- [ ] Authenticated acceptance genuinely executed its browser step — verified in
      the job log, not from the green tick.
- [ ] For a migration: filename, SHA-256, byte count and line count re-frozen
      and matched at dispatch time.
- [ ] For a migration: Production ceiling, target count, and the absence of any
      higher migration re-proved immediately before dispatch.
- [ ] Exactly one migration pending, proved twice and independently.
- [ ] `remote_history_version` freshly generated, a valid current UTC instant,
      not future-dated, strictly newer than every applied version, and absent
      from history.
- [ ] Rollback path identified and stated **before** dispatch (§4).
- [ ] No unresolved review threads; zero bypass actors on the ruleset.
- [ ] Known limitations (§12) reviewed and none newly applicable.

---

## 12. Known limitations

* **No monitoring or alerting is configured.** A Production incident is
  discovered by a person, not by an alert. Closing this needs an owner decision
  about tooling and cost.
* **Restore has never been rehearsed.** The engine exists; the evidence chain is
  empty.
* **No RPO or RTO is defined.**
* **The Windows release-engine acceptance is not a required check.** It runs on
  a path filter and would recreate the required-check deadlock (§6) if
  promoted. It cannot be silently deleted — the required contract test asserts
  it exists, runs on `windows-latest`, and keeps its zero-skipped gate — but a
  red result would not block a merge today. Promoting it requires either an
  owner decision to accept an unconditional Windows job, or a different design.
* **Documentation drift is itself a risk.** `docs/deployment-readiness.md` and
  `docs/blocker-migration-065-accumulating-receipt-concurrency.md` each carried
  a hard "do not deploy" blocker long after the code flag
  `MIGRATION_065_CONCURRENCY_RESOLVED` had been set to `true` and migration 078
  had entered the applied chain. Stale operational documentation is
  indistinguishable from a live blocker to anyone reading it cold. See §13.

---

## 13. Migration-065 blocker — current verified state

Recorded here because two documents disagreed with the code for a long time.

**Verified from the repository and from live Production evidence:**

* `MIGRATION_065_CONCURRENCY_RESOLVED` is `true` in
  `src/features/inventory/warehouse-intake-safety.ts`, and
  `warehouse-expected-generation.test.ts` asserts that value, so it cannot be
  flipped back silently.
* `supabase/migrations/078_phoenix_warehouse_receipt_expected_generation.sql`
  is part of the canonical chain, and Production's applied set reconciles as
  contiguous canonical 1..198 — so **078 is applied to Production**.

**Not verified here:** the blocker document's third condition, that the guarded
path was "observed working in a real environment". The flag's value asserts
that the person who set it was satisfied; this document does not re-derive it.

The two stale headers have been corrected to point at this section rather than
continuing to assert an open pre-deployment blocker.

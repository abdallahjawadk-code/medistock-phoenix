# DR repair proposal — migration 023 cannot be replayed from empty

**Status: PROPOSAL. Nothing here has been implemented or applied.**
**Requires owner review before any historical file is touched.**

Discovered while replaying 001→077 onto a disposable PostgreSQL 18.4 cluster to
validate migration 078. It is unrelated to blockers 1–3 and is deliberately kept
out of their commits.

---

## 1. The defect

`023_phoenix_live_profile_role_resolution_fix.sql` ends with a VERIFY block that
loads three policy expressions:

```sql
SELECT qual INTO v_insert_src
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'distribution_points'
   AND policyname = 'dp_insert_perm';
...
-- D. dp_insert_perm must still exist (must not have been dropped)
ASSERT v_insert_src IS NOT NULL,
  'VERIFY FAILED: dp_insert_perm policy missing from distribution_points';
```

`dp_insert_perm` is created by migration 021 as an **INSERT** policy:

```sql
CREATE POLICY "dp_insert_perm" ON distribution_points
  FOR INSERT WITH CHECK (...)
```

PostgreSQL stores an INSERT policy's expression in `pg_policies.with_check`, and
leaves `qual` **NULL** — `USING` is not even accepted for `FOR INSERT`. So
`v_insert_src` is always NULL and assertion D always fires.

### Proof from the disposable cluster

The policy exists and is correct; only the column being inspected is wrong:

```
policyname      | cmd    | qual_is_null | with_check_is_null
----------------+--------+--------------+-------------------
dp_insert_perm  | INSERT | true         | false
dp_read_perm    | SELECT | false        | true
dp_update_perm  | UPDATE | false        | false
```

Migration 021's own VERIFY passes, because it counts policies by name rather
than reading `qual`. 023 is the only file that inspects the wrong column.

### Blast radius

* **Production is unaffected.** 023 is already recorded as applied, and the
  policy it guards is present and correct. Nothing is broken today.
* **Disaster recovery IS affected.** A fresh `001 → latest` replay aborts at
  023. Standing up a new environment — DR rebuild, a clean staging clone, a
  contributor's local database — currently requires manual intervention.

---

## 2. The minimal correction

One expression, preserving the assertion's intent ("the policy still exists"):

```sql
  SELECT coalesce(qual, with_check) INTO v_insert_src
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'distribution_points'
     AND policyname = 'dp_insert_perm';
```

This is exactly the shim used to complete the disposable replay. With it applied
in memory, 023 and all remaining migrations through 081 applied cleanly.

A stricter variant asserts the policy row itself, which is what the comment
actually means and cannot be fooled by a NULL expression:

```sql
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='distribution_points'
       AND policyname='dp_insert_perm' AND cmd='INSERT'
  ), 'VERIFY FAILED: dp_insert_perm policy missing from distribution_points';
```

---

## 3. Which approach is safer

### Option A — correct the historical file in place

*Pros:* one-line change; the chain becomes replayable; no new concepts.

*Cons:* it **mutates an already-applied migration**, which this repository
forbids by policy and enforces in
`reviewed-migration-git-status.ts` (a modified reviewed migration is rejected —
"being reviewed permits creating a migration, never editing one afterwards").
Any checksum-based tooling would also see 023 change after the fact.

The change is provably inert on an applied database — the edited lines live
inside a `DO` block that only reads catalogs and raises; it writes nothing. But
"inert" is a judgement, and the immutability rule exists precisely so that
judgement is not exercised file by file.

### Option B — a versioned bootstrap/baseline (recommended)

Add a squashed **baseline** capturing the schema as of the latest applied
migration, and replay new environments from `baseline → 082 → …` instead of from
001. The historical files stay byte-identical and keep their audit value; the
baseline becomes the supported path for a fresh environment.

*Pros:* violates no immutability rule; also removes the 062 seed-data
precondition (a fresh replay currently needs an active `super_admin` inserted by
hand before 062); replay becomes fast and deterministic.

*Cons:* a real artefact to generate and keep current; two paths to reason about
(historical chain for audit, baseline for provisioning).

### Option C — a forward repair migration (082+)

A new migration that re-runs the corrected assertion. *This does not fix DR* —
a fresh replay still aborts at 023 before ever reaching 082. Useful only as
documentation. **Not recommended as the primary fix.**

**Recommendation: B**, with A as a fallback if the owner explicitly waives
immutability for this one line. Either way it must be its own commit, reviewed
on its own merits.

---

## 4. Acceptance criteria

Whichever option is chosen, the fix is not done until all of these hold:

1. **Fresh replay succeeds unattended.** `initdb` a clean cluster, bootstrap the
   Supabase objects, replay to the latest migration with **no manual
   intervention and no in-memory shim**. (Option B must also resolve the 062
   super_admin precondition, or document the seed as part of the bootstrap.)
2. **Schema equivalence.** Dump the schema of (i) a database built by the
   current production path and (ii) one built by the repaired path; the
   normalized diff must be **empty** — same tables, columns, constraints,
   indexes, policies, functions, grants.
3. **Policy equivalence specifically.** For `distribution_points`, the three
   policies match on `policyname`, `cmd`, `qual` and `with_check`.
4. **Data equivalence.** These migrations are structural; a before/after row
   count and checksum over every non-empty table must be identical. No rows are
   added, changed or removed by the repair.
5. **The assertion still catches the real failure.** Drop `dp_insert_perm` and
   confirm the corrected VERIFY fails. A guard that can no longer fail is worse
   than the bug.
6. **Production untouched.** The repair changes nothing on a database where 023
   is already applied — proven by running it against a clone and diffing.

---

## 5. Out of scope

This proposal does not change 023, does not add a migration, and is unrelated to
migrations 078–081. It is filed so the DR gap is visible and decided
deliberately rather than rediscovered during an actual recovery.

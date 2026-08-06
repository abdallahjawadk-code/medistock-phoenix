---
name: phoenix-protected-state-policy
description: "MediStock Phoenix ONLY — use exclusively while operating inside the MediStock Phoenix repository. This is verification METHODOLOGY, not a record of expected values: the current owner task is the sole source of every authoritative value, and this document deliberately stores none. Consult BEFORE inspecting, editing, validating, staging, or committing, to verify actual state against current-task expectations, classify every working-tree entry, and fail closed on any mismatch."
---

# Phoenix Protected State Policy

This policy defines **method, not values.**

Governed by `phoenix-owner-gates`, which takes precedence over this document
where the two overlap.

## Never Store Volatile Values Here

This skill **never** contains, and must never be edited to contain:

- a SHA-256 or any other digest;
- a commit identifier;
- a HEAD value;
- a remote or origin state;
- a migration ceiling or migration number;
- a test count;
- an approved-file count;
- a project reference;
- an address or location of an external service;
- a credential of any kind.

Every authoritative expected value is supplied by the **current owner task.**

A value frozen into this document would become wrong at the next commit and
would then be trusted anyway — which is precisely the failure this policy
exists to prevent. Freezing a value here converts a safety mechanism into a
source of false confidence.

> If the current task does not state an expected value, that value is
> **unverifiable** — not "presumed unchanged", not "probably fine".
> Report it as unverifiable, and **fail closed** if the action depends on it.

## Never Store Protected Content

This policy never contains, quotes, embeds, summarizes, or reproduces the
contents of a protected file. Verification is by **digest and byte count
only**, and only when the current task supplies the expected values to compare
against.

If completing a task appears to require reading a protected file's contents
into the working context, that is itself a finding to report — not a need to
satisfy by reading and copying it.

## Verification Method

For each expectation the current task supplies:

1. **Measure the actual value** with a read-only command against the real
   repository state.
2. **Compare exactly** against the current task's expected value — full
   digests, never abbreviations; exact counts, never approximations; exact
   identities behind every count.
3. **Report both** the expected and the actual value, whether or not they
   match. A verification whose numbers are not shown is not a verification.
4. **Verify twice**: once **before** the authorized operation and again
   **after** it. A protected file must be proven unchanged at the end of a
   task, not only at the beginning.

On any mismatch: return `FAIL-CLOSED` and stop. Do not restore, reset, check
out, stash, clean, or otherwise reconcile the difference.

A count that matches for the wrong reason is still a mismatch — confirm the
identities behind the number, not merely the number.

## Protected-File Behavior

A file the current task designates as protected is **never**:

- modified;
- staged;
- restored;
- stashed;
- overwritten;
- deleted;
- committed;
- normalized;
- reformatted.

Not to fix it. Not to make a check pass. Not because a formatter would change
it. Not because it appears to carry uncommitted changes.

Its expected condition — **including whether it is expected to be modified and
unstaged** — is stated by the current task. An owner-controlled local
modification to a protected file is a normal, expected state, not a defect to
resolve.

Digest and byte-count verification of a protected file is permitted **only**
when the current task supplies the expected digest and byte count.

## Working-Tree Classification

Every entry in the working tree falls into exactly one of five classes:

| Class | Handling |
|---|---|
| **Approved for the current task** | The exact paths this task authorizes. Only these may be created, edited, or staged. |
| **Protected** | Verified by digest and byte count against current-task expectations; never touched. |
| **Owner-controlled local change** | Left exactly as found. Its presence is expected, not a problem to solve. |
| **Generated cache, scratch, or temporary** | Excluded from every operation. Never staged, never inspected for correctness, never cleaned up unless the task explicitly says so. |
| **Unrelated** | Out of scope entirely. Not edited, not staged, not reformatted. |

**Anything that cannot be confidently placed in one of these five classes is
unexpected, and unexpected state requires `FAIL-CLOSED`.** An unexplained new
file is a state mismatch, not noise, and not something to tidy away.

## Prior Committed Work

When the current task requires that previously committed work remain unchanged,
verify it **byte-identically against the commit the current task names** as its
source: compare each file's digest against the content stored in that commit.

**Do not rely on a status listing or a diff summary alone.** A summary can be
clean while content differs in ways the summary does not surface, and a status
line reports what the index believes rather than what the file contains. Prior
work is verified by comparing content, file by file.

Prior committed files are never reformatted, re-linted, "improved", or
restaged, however tempting the change.

## Staging Protection

- **Repository-local skill placement does not authorize staging the `.claude`
  directory**, or any directory. Placing policy files inside a directory grants
  no permission over anything else in it.
- **`.claude/launch.json` may be a tracked, owner-controlled file** whose
  expected state is supplied by the current task — commonly modified and
  unstaged. Being tracked and modified does not make it a candidate for
  staging; it makes it a file to verify and leave alone.
- **Ignore rules do not protect an already tracked file from staging.** An
  ignore entry affects untracked files only. Once a file is tracked, no ignore
  configuration prevents a directory-level staging command from picking it up.
  Ignore rules are therefore never a substitute for exact-path staging, and the
  absence of an ignore rule is never a reason to widen a staging command.
- **Only exact file-path staging is allowed**, per `phoenix-owner-gates`.
- **The staged set must be checked for every protected path** before any
  commit — each protected path confirmed absent by name, not inferred from a
  matching file count.

## Evidence

Report the read-only commands used and their actual output. Never report an
expectation as verified when the check was skipped, unavailable, inferred from
a prior task's result, or assumed from an unchanged-looking summary.

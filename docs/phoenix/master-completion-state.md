# MediStock Phoenix — Master Completion State

**Rights:** MASAR — PH. Abdallah Jawad
**Branch:** `master`
**Last updated:** 2026-07-16

This document is the resume point. Read it first on every invocation, verify the
repository, and resume from the first incomplete checkpoint.

---

## Current position

| Field | Value |
| --- | --- |
| **Completed** | Checkpoint 0 — Preflight and Baseline |
| **Completed** | Checkpoint 1 — Repository-Local RBAC Parity Repair |
| **Current** | Checkpoint 2 — Windows Local Runtime Preparation |
| **Pending** | Checkpoints 3–9 |
| **Verified SHA (start)** | `c9653061db1016f9125affc2ea8060b2848c652b` |
| **Checkpoint 1 commit** | `<recorded below on commit>` |

---

## Checkpoint 0 — Preflight and Baseline ✅

### Repository verification

| Check | Result |
| --- | --- |
| Branch | `master` |
| HEAD | `c9653061db1016f9125affc2ea8060b2848c652b` |
| origin/master | `c9653061db1016f9125affc2ea8060b2848c652b` |
| Divergence | `0 0` |
| Working tree | only the two expected untracked paths |
| Migration ceiling | `063` — **no Migration 064** ✅ |
| Migration count | 63 files + `__tests__` |
| `stash@{0}` | present, untouched ("paused Service-D inter-org exchange service work") |

### Toolchain

| Tool | Version |
| --- | --- |
| Node | v26.2.0 |
| npm | 11.16.0 |
| Git | 2.55.0.windows.2 |
| Supabase CLI | 2.109.0 |
| WSL | ❌ `REGDB_E_CLASSNOTREG` (Class not registered) |
| Docker | ❌ unavailable |

No secret environment values were printed.

### Baseline gates (application code unmodified)

| Gate | Result |
| --- | --- |
| Vitest | ✅ **7307 passed** / 130 files |
| `tsc --noEmit` | ✅ clean |
| `tsc -b` | ✅ clean |
| Production build | ✅ built in ~7s |
| Lint | ⚠️ **4 baseline problems (2 errors, 2 warnings)** — pre-existing |
| `git diff --check` | ✅ clean |

**Baseline lint problems (pre-existing — must not increase):**
1. `IntakeFrozenScreen.tsx:15` — warning, unused `onNavigate`
2. `MeshScreen.tsx:14` — warning, unused `onNavigate`
3. `MovementHistoryModal.tsx:84` — error, `react-hooks/exhaustive-deps` rule not found
4. `registerServiceWorker.ts:17` — error, unused eslint-disable directive

---

## Checkpoint 1 — Repository-Local RBAC Parity Repair ✅

### Audit result

Full matrix: **`docs/phoenix/rbac-role-permission-parity-matrix.md`**

Exactly one `MISMATCH` existed across all roles and all shared keys:

| Role | Key | Migration 062 | Frontend (before) | After |
| --- | --- | --- | --- | --- |
| `warehouse_officer` | `warehouses.manage` | `false` | `true` | absent → `false` ✅ |

All other pairs are `MATCH`, `INTENTIONAL_LEGACY` (documented with reason), or
`NOT_SURFACED` (fail-closed).

### Repair performed

- Removed **only** `warehouses.manage` from `WAREHOUSE_OFFICER_DEFAULTS`.
- Preserved `warehouses.view` and all 24 other keys (pinned by exact-set test).
- `hospital_admin` retains `warehouses.manage` — `INTENTIONAL_LEGACY`; 062's C1
  names `warehouse_officer` only, and re-scoping legacy roles is explicitly out
  of that migration's contract.
- `transfer_manager` remains authorization-distinct (frozen snapshot list).
- No legacy alias inherits any 062 key.
- User Management already treats `get_effective_permissions` as authoritative and
  forces the fallback read-only (`UserManagementScreen.tsx:490-513`) — verified,
  no change needed, now pinned.

### Files changed

| File | Change |
| --- | --- |
| `src/shared/lib/permissions.ts` | removed `warehouses.manage` from `WAREHOUSE_OFFICER_DEFAULTS` + rationale comment |
| `src/features/users/__tests__/user-permission-matrix.test.ts` | corrected the test that asserted the divergence as correct |
| `src/shared/lib/__tests__/rbac-fallback-parity.test.ts` | **new** — 19 parity tests, parses 062 SQL |
| `docs/phoenix/rbac-role-permission-parity-matrix.md` | **new** — parity matrix |
| `docs/phoenix/master-completion-state.md` | **new** — this document |

**No migration file was created or edited.** No SQL ran. No RLS weakened.

### Gates

| Gate | Result |
| --- | --- |
| Vitest | ✅ **7326 passed** / 131 files (+19 tests, +1 file; zero regressions) |
| `tsc --noEmit` | ✅ clean |
| `tsc -b` | ✅ clean |
| Production build | ✅ succeeds |
| Lint | ✅ **4 problems — identical to baseline, zero new** |
| `git diff --check` | ✅ clean |
| Mutation check | ✅ reintroducing the bug fails 6 tests incl. the general D3 guard |

### Note for future phases: the 15 isolation guards

15 historical phase-guard tests assert `git diff -- <file>` is empty for
`permissions.ts` and other safety files. They compare the **working tree against
the index**, so they fail while a legitimate change is uncommitted and pass once
it is staged/committed. They are *uncommitted-change* detectors, not regressions.
**Do not "fix" them** — stage the change and re-run.

---

## Checkpoint 2 — Windows Local Runtime Preparation ⏸️

**Status: WAITING FOR OWNER — WSL2 is not installed.**

`wsl --status` fails with `REGDB_E_CLASSNOTREG`; `docker info` finds no server.
This blocks Checkpoints 3 and 4, which require a local Postgres to replay
migrations 001–063 and run real Auth/RPC/RLS tests. No silent OS install is
permitted, and enabling WSL2 requires administrator rights and a reboot.

Scripts are prepared on the Desktop. See "Owner action required" below.

---

## External blockers

| Blocker | Blocks | Owner action |
| --- | --- | --- |
| WSL2 not installed (`REGDB_E_CLASSNOTREG`) | CP 3, 4 | Run `MediStock_Enable_WSL2_Admin.cmd`, reboot |
| Docker Desktop not installed | CP 3, 4 | Install after WSL2, accept license |
| No separate Supabase staging project | CP 7, 8 | Create project + provide non-production credentials |

---

## Owner approvals still required

- Merge of `feature/phoenix-application-completion` (CP 5)
- Merge of `feature/phoenix-cinematic-redesign` (CP 6)
- Any Migration 064 (requires separate technical report)
- Every RBAC enforcement step (CP 8)
- Any production deployment

---

## Production-safety invariants (verified this run)

- ❌ No `supabase db push`
- ❌ No production link, no remote migration repair
- ❌ No production SQL, no production deploy
- ❌ No migration 001–063 edited, no Migration 064 created
- ❌ No RLS weakened
- ✅ Production RBAC mode remains **off**; engine remains **shadow**
- ✅ `premium-preview.html` untouched and unstaged
- ✅ `supabase/.temp/` untouched and unstaged
- ✅ `stash@{0}` untouched
- ✅ No force push, no destructive reset
- ✅ No secrets committed

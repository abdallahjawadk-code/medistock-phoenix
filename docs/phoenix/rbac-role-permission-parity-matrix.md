# MediStock Phoenix — RBAC Role/Permission Parity Matrix

**Rights:** MASAR — PH. Abdallah Jawad
**Checkpoint:** 1 — Repository-Local RBAC Parity Repair
**Authority:** the DATABASE is authoritative. This matrix records where the
frontend *fallback* (`src/shared/lib/permissions.ts`) agrees with Migration 062.

The fallback is used only when `get_effective_permissions` cannot be read. It
must never out-grant the database. It may under-grant (fail-closed).

---

## Status legend

| Status | Meaning |
| --- | --- |
| `MATCH` | Fallback equals Migration 062's stated default. |
| `INTENTIONAL_LEGACY` | Differs by deliberate decision, recorded below with its reason. |
| `NOT_SURFACED` | 062 key absent from the frontend catalog — denies by absence (fail-closed). |
| `MISMATCH` | Fallback out-grants the database. **None may remain.** |

---

## 1. The corrected divergence

| Role | Permission key | Migration 062 | Frontend (before) | Frontend (after) | Status |
| --- | --- | --- | --- | --- | --- |
| `warehouse_officer` | `warehouses.manage` | `false` (C1 UPDATE + C2 INSERT) | `true` | **absent → false** | **MISMATCH → MATCH** |
| `warehouse_officer` | `warehouses.view` | `true` (010, untouched) | `true` | `true` | `MATCH` |

**Why this was the bug.** Migration 010 granted `warehouse_officer`
`warehouses.manage`. Migration 060 then made that key authorize org-wide
INSERT/UPDATE on warehouse **master records** — create, rename, re-code, flip
`is_main` (moving the organization's authoritative main warehouse), archive.
Migration 062 (section C1) set the default to `false`: the role is a Warehouse
**Data Entry** Officer, not a warehouse owner. The frontend fallback still
granted it, so a fallback-resolved officer saw warehouse-master affordances the
database denies.

**Why removal is safe.** 060's `wh_insert_perm` / `wh_update_perm` policies are
deliberately unchanged and still gate on `warehouses.manage`. Removing the
*default* is what closes the hole. An operator who deliberately grants the key
back via an override still gets 060's org-scoped behavior — an explicit, audited
decision, not a silent role default. Pinned by test B: *"an explicit override can
still grant the key back"*.

---

## 2. `warehouses.manage` across all roles

| Role | Migration 062 | Frontend fallback | Status |
| --- | --- | --- | --- |
| `super_admin` | `true` (seeded from every key) | `true` (ALL_KEYS) | `MATCH` |
| `institution_admin` | no row — 012 never granted it | absent | `MATCH` |
| `hospital_admin` | no row — **062 C1 names `warehouse_officer` only** | `true` (010) | `INTENTIONAL_LEGACY` |
| `warehouse_officer` | `false` | absent | `MATCH` (repaired) |
| `port_officer` | `false` (explicit deny) | absent | `MATCH` |
| `monthly_status_officer` | no row | absent | `MATCH` |
| `transfer_manager` | no row | absent | `MATCH` |
| `viewer` | no row | absent | `MATCH` |
| `warehouse_manager` | untouched by 062 (010's copy) | n/a — hidden legacy | `INTENTIONAL_LEGACY` |

**`hospital_admin` is deliberately NOT demoted.** 062's C1 names
`warehouse_officer` and nothing else, and its own header states that quietly
re-scoping legacy roles is out of that migration's contract. Removing the key
from the fallback would make the frontend diverge from the database in the
*other* direction — under-granting a role the DB still permits, which would break
a working legacy deployment. Any change here requires its own migration, report
and owner approval. Pinned by test C: *"hospital_admin KEEPS warehouses.manage"*.

---

## 3. Migration 062's ten new keys

None of the ten are present in the frontend catalog (`PERMISSION_KEYS`, 55 keys).
This is deliberate and pre-existing — see the header of
`src/shared/authz/scoped-permissions.ts`: adding them would render ten new
checkboxes and activate user-scope mutations, which the shadow phase explicitly
does not do.

**Security consequence: fail-closed.** A key absent from the fallback resolves to
`false`, so the fallback cannot out-grant the database on any of them. The
database remains authoritative.

| Key | 062 grants `true` to | Frontend | Status |
| --- | --- | --- | --- |
| `warehouse_stock.view` | `warehouse_officer`, `institution_admin`, `hospital_admin`, `viewer` | absent | `NOT_SURFACED` |
| `warehouse_stock.adjust` | `warehouse_officer` only | absent | `NOT_SURFACED` |
| `warehouse_stock.correct` | `warehouse_officer` only | absent | `NOT_SURFACED` |
| `warehouse_stock.movements_view` | `warehouse_officer`, `institution_admin`, `hospital_admin`, `viewer` | absent | `NOT_SURFACED` |
| `reports.view` | `warehouse_officer`, `port_officer`, `institution_admin`, `hospital_admin`, `viewer`, `monthly_status_officer` | absent | `NOT_SURFACED` |
| `reports.financial` | `institution_admin`, `hospital_admin` | absent | `NOT_SURFACED` |
| `reports.export` | `institution_admin`, `hospital_admin` | absent | `NOT_SURFACED` |
| `audit.view` | all except `transfer_manager` | absent | `NOT_SURFACED` |
| `users.edit_scope` | `institution_admin`, `hospital_admin` | absent | `NOT_SURFACED` |
| `users.reset_permissions` | `institution_admin`, `hospital_admin` | absent | `NOT_SURFACED` |

These surface in **Checkpoint 5**, when the modules that consume them exist.

---

## 4. Read-only role integrity

| Requirement | 062 | Frontend | Status |
| --- | --- | --- | --- |
| `institution_admin` stock read-only | `view`/`movements_view` = `true`; `adjust`/`correct` = **`false`** | no stock keys | `MATCH` (fail-closed) |
| `hospital_admin` stock read-only | same as above | no stock keys | `MATCH` (fail-closed) |
| `viewer` read-only | read keys only | 11 keys, all `.view` | `MATCH` |
| `transfer_manager` no new 062 key | every new key `false`/absent | frozen 12-key list | `MATCH` |

062's reasoning, preserved: *oversight that can silently rewrite the quantities it
oversees is not oversight.*

---

## 5. `transfer_manager` authorization distinctness

`normalizeRole('transfer_manager')` returns `transfer_manager` — it is **never**
resolved through `monthly_status_officer`. Migration 010 seeded it by *copying*
that role's defaults (identical today); 062 then diverged them —
`monthly_status_officer` gained `reports.view` + `audit.view`, `transfer_manager`
gained neither. `TRANSFER_MANAGER_LEGACY_DEFAULTS` is a frozen snapshot, not a
derivation, precisely so the next key added to `monthly_status_officer` cannot
silently become a `transfer_manager` grant the database denies.

---

## 6. Effective-permission authority

`UserManagementScreen` resolves permissions via `getEffectivePermissions(user.id)`
(the `get_effective_permissions` RPC). The role-default fallback is used **only**
to synthesize a display when the RPC returns nothing — and in that case the
matrix is forced `readOnly`, so a fallback-derived value can never be saved back
over real overrides. Verified at `UserManagementScreen.tsx:490-513`.

---

## 7. Enforcement

`src/shared/lib/__tests__/rbac-fallback-parity.test.ts` (19 tests) parses the
committed Migration 062 SQL rather than re-stating it, so a future edit to either
side that reintroduces a divergence fails the suite.

Test **D3** is the general guard: for every key present in both the frontend
catalog and 062's stated defaults, a `false` in the database must not be `true`
in the fallback — the general form of the `warehouses.manage` bug, for all roles
and all keys.

**Mutation-verified:** reintroducing `warehouses.manage` into
`WAREHOUSE_OFFICER_DEFAULTS` fails 6 tests, including D3. The suite is not a
vacuous pass.

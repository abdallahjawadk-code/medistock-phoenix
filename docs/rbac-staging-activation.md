# Scoped RBAC — staging shadow activation

Runbook for turning on **shadow mode** in staging so real mismatches between the
current authorization engine and migration 062 can be reviewed.

This document does not deploy anything. It is the instruction set for a human
who will.

---

## 1. What state are we actually in?

These six states get collapsed into "shadow mode is on" and they are not the
same thing. Read this table before quoting any of them.

| State | What it means | True today? |
|---|---|---|
| **Code merged** | The scoped authorization layer exists in `master`. | **Yes** — `d3402c3` |
| **Dev/test default** | Local dev and Vitest resolve to `shadow` with no configuration. | **Yes** |
| **Staging shadow activation** | A staging build explicitly sets `VITE_PHOENIX_SCOPED_RBAC_MODE=shadow`. | **No** — this runbook prepares it |
| **Production off** | Production resolves to `off`; the scoped engine never runs. | **Yes** |
| **Super-admin pilot** | `enforce_super_admin` gates routes for `super_admin` only. | **No** — implemented, not enabled anywhere |
| **Broad enforcement** | The scoped engine gates all roles. | **No** — no such flag value exists |

> **Shadow mode is NOT active in production.** It is active in a deployed
> environment only if that environment's build was produced with
> `VITE_PHOENIX_SCOPED_RBAC_MODE=shadow` present. Unset means `off` in
> production. There is no runtime toggle — see §3.

## 2. What shadow mode does and does not do

- **Does**: compute the migration 062 decision alongside the current one on
  read-only surfaces, compare them, and accumulate the disagreements in memory
  for export.
- **Does not**: change any authorization outcome, for any role. The effective
  answer stays whatever it is today. Nobody is blocked, and nobody is granted
  anything, because the scoped engine disagreed.
- **Database**: untouched. RLS and the 060–063 functions remain authoritative
  for data access, in every mode.

## 3. Activation

`VITE_*` variables are inlined by Vite at **build** time. This is a
build-and-deploy operation, not a console switch — which is deliberate: enabling
scoped authorization should be a reviewed artifact, not a toggle someone can
flip at 2am.

### 3.1 Set the variable in the staging environment

```
VITE_PHOENIX_SCOPED_RBAC_MODE=shadow
```

Set it wherever staging builds get their environment (e.g. the hosting
provider's environment settings for the staging deployment). Do not put it in a
committed `.env.local`.

Leave every other variable alone. In particular, staging must keep pointing at
its own Supabase project — this runbook changes **one** variable.

### 3.2 Clean build

```bash
npm ci
npm run build
```

`npm ci` rather than `npm install`: a lockfile-exact install, so the artifact
under test is the artifact that was reviewed.

### 3.3 Confirm the environment took effect

Before trusting any telemetry, confirm the build is actually in shadow mode.
Open the staging app with the browser console visible. A **development** build
logs the configuration diagnostic at startup:

```
[phoenix][rbac] scoped RBAC configuration
  { mode: "shadow", environment: "…", scopedEvaluationEnabled: true,
    enforcementActive: false, explicitlyConfigured: true }
```

The two fields that matter:

- `mode: "shadow"` — the engine will run.
- `explicitlyConfigured: true` — the value came from the environment, **not**
  from a default. If this is `false` on a staging build, the variable did not
  reach the build and the deployment is still effectively `off`.

A production-mode staging build does not print this line. Confirm it instead
from the telemetry export (§4), whose header carries the same `mode`.

If `mode` is not `shadow`, **stop**. The variable did not reach the build. Do
not interpret an empty mismatch report as "no mismatches" — see §4.

## 4. Reviewing mismatches

Telemetry is in-memory, per browser session, bounded, and never transmitted. It
dies with the tab. To collect it:

1. Sign in as each account in §5 and visit the routes listed there.
2. Export from the browser console:

```js
copy(JSON.stringify(JSON.parse(window.__phoenixRbacTelemetry?.exportJson() ?? '{}'), null, 2))
```

If the export returns `{"error":"TELEMETRY_DISABLED", …}`, the build is `off`
and collected nothing. **This is not the same as "no mismatches found"**, and
the two must never be reported as the same result.

Each event carries: role, permission key, scope type, organization and resource
references, the legacy result, the scoped result, a reason code, an occurrence
count, and first/last seen. It carries no name, email, token, document or
clinical value, and the profile identifier is truncated to 8 characters.

`outcome` is the field to read first:

- `disagreement` — both engines answered and differed. **This is the signal.**
- `unknown` — the scoped RPC could not answer (network/permissions). This is
  RPC health, **not** an RBAC finding. Do not count it as a mismatch.

## 5. Smoke test

Sign in as each role and visit each route. The application has no
warehouse/stock/dispatch screens yet, so the observable surfaces are:

| Route | Screen | Keys observed |
|---|---|---|
| Reports | `ReportsScreen` | `reports.view` |
| Reports → Audit tab | `AuditLogSection` | `audit.view` |
| Users | `UserManagementScreen` | `users.edit_scope`, `users.reset_permissions` |
| Any authenticated route | app shell | route guard (observe-only) |

Accounts to exercise — use existing staging accounts; **do not create
production users for this**:

1. `super_admin`
2. `warehouse_officer`
3. `institution_admin`
4. `hospital_admin` (legacy admin)
5. `viewer`
6. `monthly_status_officer`
7. `transfer_manager` (hidden legacy — only if a staging account already exists)

Expected: every screen behaves exactly as it does today, for every account. Any
behavior change is a bug in the shadow layer, not a finding — report it as such.

See `src/shared/authz/__tests__/observation-matrix.test.ts` for the decision each
role is expected to produce and whether a mismatch is expected.

## 6. Rollback

```
VITE_PHOENIX_SCOPED_RBAC_MODE=off
```

Then rebuild and redeploy (§3.2). That is the whole rollback.

- **No database rollback is required or possible** — this phase changed no
  schema, no function, no policy and no row. Migrations 060–063 are untouched
  and stay applied.
- No user data is affected. Telemetry is in-memory and is gone the moment the
  tab closes.
- Removing the variable entirely is equivalent to `off` in production.

## 7. Prohibitions

- Do not set `enforce_super_admin` in staging or production as part of this
  phase. It is implemented and tested; enabling it is a separate, later decision
  that needs mismatch evidence first.
- There is no flag value that enforces for all roles. Do not add one here.
- Do not run any SQL, migration or `supabase db push` for this activation.
- Do not put a real key or project URL in this file.

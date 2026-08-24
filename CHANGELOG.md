# Changelog

Release record for **MediStock Phoenix**. This file starts at the first intended
tagged release; earlier work is recorded in `docs/phoenix/HISTORY/` and in the
stage documents under `docs/phoenix/`. **No prior version is reconstructed
here** — inventing a version history the repository never shipped would make
this file less trustworthy, not more.

---

## v2.0.0

Planned first tagged release. `package.json` has declared `2.0.0` throughout.
**J-2 does not create the tag.** The `v2.0.0` tag is reserved for J-3, after
the final whole-program audit, so it can point at the final audited release
commit rather than at an intermediate state.

### What ships

A medical supply-chain platform for warehouses, institutions, pharmacies,
outlets, shock cabinets, rescue carts and patient dispensing — covering direct
and routed supply, receipt, returns, quarantine and recall, FEFO with material
identity, transfers and transfer suggestions, inter-organization alerts and
exchange, the anonymous public QR portal, reporting and export, and
role/permission management with delegated and facility-scoped access.

* **Frontend** — React + Vite on Vercel. WebGL scenes are lazily isolated: the
  three.js chunk has no static importer in the eager graph, so the 2D-fallback,
  Save-Data and no-WebGL paths never fetch it.
* **Mobile / PWA** — authenticated shell, dialogs, drawer, command palette,
  notifications, forms, Login/Welcome and public QR surfaces converge on the
  same 767px responsive boundary, use dynamic viewport units and safe-area
  insets, and react to rotation/split-screen changes without requiring reload.
  Authenticated browser acceptance exercises 320×568, 360×800, 390×844,
  430×932 and 667×375 landscape viewports.
* **Authentication liveness** — the three cold-start reads (session, profile
  and effective permissions) are deadline-bounded. A silent transport cannot
  leave the application in a permanent loading state; silence fails closed and
  never becomes a fabricated `no_session`.
* **Database** — Supabase PostgreSQL, canonical migrations `001`–`198`,
  applied through one pinned executor.
* **Edge Functions** — `admin-create-user`, `admin-user-lifecycle`,
  `admin-recycle-user`, `phoenix-outbox-dispatcher`.

### Security posture at this release

* First-party `SECURITY DEFINER` routines with PostgreSQL `PUBLIC` EXECUTE:
  **0** (migration 197).
* First-party `SECURITY DEFINER` routines on a bare `search_path = public`:
  **0**; all 321 carry `public, pg_temp` (migration 198), so the temporary
  schema can no longer be searched first and shadow a `public` name.
* Anonymous surface: `get_public_qr_payload(text)` is the only routine granted
  to `anon`, returning public-safe fields keyed by a random `public_id`.
* Identity helpers `phoenix_my_org()` and `phoenix_my_role()` are reachable
  by `authenticated` through explicit grants, not through `PUBLIC`
  inheritance.
* Security headers: CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`.
* Dependencies: **0 known vulnerabilities** at the release-candidate gate
  (`npm audit --audit-level=moderate`).

### Release verification

The release-candidate gate immediately before this record was refreshed proved:

* **Security and quality gates — PASS**: typecheck, lint, production build and
  Vercel configuration validation succeeded; the standard suite reported
  **431 test files / 15,455 tests passed**, with the dynamic files reported
  separately rather than silently counted as ordinary-suite coverage.
* **PostgreSQL pg-rig — PASS**: migrations replayed on disposable PostgreSQL;
  the dynamic suites passed; TLS-only PostgreSQL 17 accepted encrypted
  connections, refused plaintext TCP, replayed migrations `001`–`196`, and
  passed the mixed-history / shadow-workspace acceptance.
* **Authenticated browser acceptance — PASS**: the real disposable-Supabase
  browser corridor passed **116/116 assertions**, including the five-viewport
  mobile matrix, settled drawer/dialog geometry, focus ownership and the
  existing operational corridors.
* **Vercel — PASS** on the exact mobile-convergence release-candidate head and
  on the subsequent merge to `master`.

### Release governance

Merges to `master` require four status checks — *Security and quality gates*,
*PostgreSQL pg-rig*, *Vercel*, and *Authenticated browser acceptance
(disposable local Supabase)* — under ruleset `21216543` with **zero bypass
actors**. The authenticated acceptance runs for every pull request targeting
`master`; it is deliberately unconditional, because a required status check
that can fail to emit blocks its pull request forever.

Production migrations are applied only by
`.github/workflows/apply-production-migration.yml`, which proves exactly one
migration is pending twice and independently before writing, and classifies any
failure as `FAILED_CLEAN` / `FAILED_PARTIAL` / `AMBIGUOUS` rather than
retrying.

### Accepted limitations at this release

Recorded so the release is not read as claiming more than it delivers. Full
detail in [`docs/phoenix/OPERATIONS.md`](docs/phoenix/OPERATIONS.md).

| Area | Status |
|---|---|
| RPO / RTO | **NOT_FORMALLY_COMMITTED** — no production SLA is claimed |
| Backup / PITR / retention | **EXTERNAL_PLATFORM_EVIDENCE_REQUIRED** — not proven from this repository |
| Restore rehearsal | **NOT PERFORMED** — the engine exists and is owner-operated by design |
| Monitoring / alerting | **MANUAL** — incidents are found by a person, not an automated alert |
| On-call rota | **NONE CLAIMED** — operational ownership is owner-held |
| Edge Function CORS (D3) | **RESIDUAL_ACCEPTED_RISK** — non-credentialed wildcard, Bearer-token auth, no cookies; see the security audit |

None of the above is a proven capability, and none may be presented as one.

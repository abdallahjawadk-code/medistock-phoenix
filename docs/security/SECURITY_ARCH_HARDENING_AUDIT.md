# Security & Architecture Hardening — Audit & Fix Package

**Branch:** `feat/phoenix-security-arch-hardening` (stacked on PR #45 → PR #44 → `master`)
**Base HEAD:** `239fe00` (PR #45 head, CI-green)
**Date:** 2026-07-22
**Scope:** Read-only audit of the whole app + DB surface, then apply confirmed, safely-fixable findings, and (second pass) close deferred **D1** and **D2** with an atomic, additive, backward-compatible server-side contract. **No Production mutation, no merge, no deploy, no migration applied.**

Migration high-water mark across all branches was **092** (master=087, PR#44 adds 088–090, PR#45 adds 091–092). Closing D1 required one new, additive, transaction-wrapped migration — **093** (`093_phoenix_super_admin_lifecycle_guard.sql`), the first free number, registered in the reviewed-migrations registry. It is prepared and rig-validated but **not applied to Production**.

---

## 1. Findings

Severity reflects confirmed, evidenced exploitability in this codebase — not textbook worst case.

| # | Sev | Area | Finding (evidence) | Impact | Fix | Test | Status |
|---|-----|------|--------------------|--------|-----|------|--------|
| F1 | **Low–Med** | A/E headers | No `Strict-Transport-Security` header. `vercel.json` shipped CSP + XFO + nosniff + Referrer-Policy + Permissions-Policy but **no HSTS**; Vercel does not add it automatically. | First-visit / typed-`http://` request is SSL-strip / MITM-able before the HTTPS redirect. (`upgrade-insecure-requests` already covers subresources, limiting blast radius.) | Added `Strict-Transport-Security: max-age=31536000` to `vercel.json` (host-scoped; no `includeSubDomains`/`preload` to avoid affecting sibling subdomains). | `tests/security-headers-contract.test.ts` — proven to fail on pre-fix `vercel.json`, pass after. | **FIXED** |
| F2 | **Low (guard gap)** | D DB | No regression guard that **every** `SECURITY DEFINER` function pins `search_path`. Audit confirmed 171/171 currently pin it, but nothing prevented a future migration from omitting it (CWE-426 / Supabase "Function Search Path Mutable"). | A future unpinned definer function referencing unqualified objects would be a privilege-escalation vector, silently. | No code change needed — the invariant already holds. Added a durable guard. | `tests/definer-search-path-guard.test.ts` — parses all migrations, resolves each function's final definition, asserts all definers pin `search_path`. | **FIXED (guard added)** |
| F3 | **Low** | A/E headers | No regression guard that the security headers themselves stay present/strong in `vercel.json`. | A future edit could silently drop CSP/XFO/HSTS with no runtime error. | Guard only. | `tests/security-headers-contract.test.ts` asserts presence + security-relevant shape (script-src has no `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`, HSTS ≥ 1y). | **FIXED (guard added)** |

### D1 & D2 — CLOSED in this package (migration 093 + Edge-Function refactor)

| # | Sev | Finding | Fix | Test | Status |
|---|-----|---------|-----|------|--------|
| D1 | **Med** | **TOCTOU on the last-active-super_admin guard.** The old Edge Functions counted active super_admins then mutated auth + profiles non-atomically; two concurrent `disable`/`delete` on two different super_admins could each read count=2 and both proceed → **zero** platform managers. | **Atomic server-side contract** (migration `093`): `phoenix_lifecycle_reserve` takes a single shared `pg_advisory_xact_lock`, re-checks the invariant, and **commits** the reservation + `status='suspended'` transition together — the decision is *persisted*, not just lock-guarded, so a concurrent reserve observes the target as no longer active. `phoenix_lifecycle_compensate` restores the exact prior status if the external Auth call fails (no half-deleted account, no privilege change). The three Edge Functions now delegate all profile role/status transitions to the contract (`reserve`/`commit`/`note_delete`/`compensate`/`enable`/`authorize_rotation`/`provision_profile`/`recycle_apply`) and keep only Auth Admin calls. | `tests/lifecycle-guard-concurrency.test.ts` (disposable PG rig, two real connections): concurrent disable **and** delete never reach zero; compensation restores state. Proven to fail under the old non-atomic logic (both siblings suspended → 0). | **FIXED** |
| D2 | **Low** | **User-existence oracle for `institution_admin`.** Distinct `TARGET_NOT_FOUND` / `CROSS_ORG_FORBIDDEN` / `INSUFFICIENT_PERMISSION` let a privileged actor probe existence/cross-org membership of arbitrary UUIDs. | Every authorization/existence denial in the contract returns a single generic **`REQUEST_DENIED`** with a correlation id, while the real reason (`target_not_found` / `cross_org` / `target_platform_managed` / …) is written to the RLS-protected `audit_logs` (`action='security.access_denied'`) — no secrets, target by id only. The Edge Functions thread the request `x-correlation-id` through. `create` keeps its distinct role messages (no existing-target oracle surface). | Same rig test: `notFound` / `crossOrg` / `platform` denials are byte-identical to the caller; the server log distinguishes all three. | **FIXED** |

Migration `093` functions are all SECURITY DEFINER with `search_path` pinned, REVOKE PUBLIC/anon, EXECUTE to `authenticated` only (each re-derives authority from `auth.uid()`); registered in the reviewed-migrations registry; validated on a full 001→093 disposable replay.

### Deferred (accepted risk with review condition)

| # | Sev | Area | Finding | Why deferred | Containment / review condition |
|---|-----|------|---------|--------------|-------------------------------|
| D3 | **Low/Info** | B auth | Edge Functions set `Access-Control-Allow-Origin: '*'`. | Functions are **Bearer-token** authed (no cookies), so `*` grants no CSRF/credential-theft path; a stolen token is the prerequisite regardless of origin. Restricting origins now risks breaking Vercel **preview** deployments (dynamic hostnames), and CORS was explicitly out of scope for this package. | **Accepted temporarily.** Review condition: once a stable production origin (and a preview-origin policy) is fixed, replace `'*'` with an allowlist keyed off a configured app-origin env var. No data exposure in the interim (token-gated, server-authorized). |

---

## 2. Positive assurance (audited, no action needed — with evidence)

These were actively checked and found sound; recorded so "no finding" is evidenced, not assumed.

- **No secrets in the client bundle.** `grep` of `dist/` for `service_role`, JWTs (`eyJ…`), private-key headers, and Supabase URLs found **none** (only the CI placeholder `example.supabase.co`). **No sourcemaps** are emitted to `dist/`.
- **`service_role` never in browser code** — only in the three Deno Edge Functions; enforced by existing `phoenix-guardrails` tests.
- **SECURITY DEFINER hygiene.** All **171** definer functions pin `search_path` in their final definition (now guarded — F2).
- **Grants.** Only `get_public_qr_payload(text)` is granted to `anon` (intentional public-QR scan); no other anon/PUBLIC write grants. The RPC returns only public-safe fields, keyed by a random `public_id` (no cross-org leak).
- **Server-side authority (no IDOR in sampled critical RPCs).** `phoenix_suggest_inventory_transfers`, `phoenix_status_center_authorized`, `phoenix_status_prepare_report` all derive authority from `auth.uid()` + `phoenix_profile_has_scoped_permission` / org-match, raising on mismatch — client-passed `p_organization_id` is a **scope argument, not the authority**.
- **XSS / injection in exports & print.** Shared `reportExport.ts` and the inline print builders (`StatusCenterScreen`, `MovementReportSection`, `QrScreen`, `InstitutionScreen`) pass every user/DB value through `escHtml`; CSV export applies the `csvSafeCell` formula-injection guard. QR `<img src>` is a generated `QRCode.toDataURL` data URL, not user text.
- **Service worker never caches auth/medical data.** `public/sw.js` returns early for any `*.supabase.co` / `/rest|/auth|/rpc|/storage` request; caches only same-origin GET app-shell assets, network-first.
- **CSP** already blocks inline/eval scripts (`script-src 'self'`), framing (`frame-ancestors 'none'`, XFO `DENY`), and objects (`object-src 'none'`).

---

## 3. Delivery gates (local)

| Gate | Result |
|------|--------|
| `typecheck` | clean |
| `lint` (CI `--max-warnings 4`) | 4 warnings = baseline (new `tests/` files are outside lint scope) |
| `build` | success |
| full test suite | green on CI (only the two known local-only artifacts below fail locally) |
| security guard tests | HSTS + headers + search_path guards pass (HSTS proven to fail pre-fix) |
| D1/D2 dynamic proof | `tests/lifecycle-guard-concurrency.test.ts` — 5 tests pass on the disposable PG rig (skips on CI, which has no Postgres) |
| disposable DB replay | full 001→093 chain replays cleanly on PG 18.4 |
| npm audit (`--audit-level=moderate`) | 0 vulnerabilities (093 adds no dependency) |
| bundle secret scan | clean (no `service_role`/JWT/service key) |
| **CI (PR #46)** | **green** — Security-and-quality-gates + Vercel + Preview |

**Known local-only non-failures (pass on CI, per repo convention):**
1. `authz-security-scan` `premium-preview.html` guard — CI fabricates that file (`install -m 600 /dev/null`); it is absent locally.
2. Intermittent `git diff -- …StatusCenterScreen.tsx` "Could not access" under vitest parallel workers — git contention (verified: the affected files pass when run serially). Absent on CI's isolated checkout.

## 4. Rollback & later activation

- **Rollback:** revert this branch's commits — nothing else to undo. **Migration 093 is NOT applied to Production by this PR** (it lives on disk + in the reviewed registry; the disposable rig is the only place it has run). `vercel.json` header revert is a one-line diff.
- **Later activation:** at the same attested cutover that applies 088–092, apply `093` (transaction-wrapped) after `092`, then deploy the three refactored Edge Functions (`supabase functions deploy admin-user-lifecycle admin-create-user admin-recycle-user`). The HSTS header takes effect on the next Vercel deploy. The frontend already tolerates the new `REQUEST_DENIED` code (mapped to `um_request_denied`). Order: **migration 093 → Edge Functions → frontend** (frontend is backward-compatible either way).

## 5. Explicit confirmation

**No Production mutation. No merge. No deploy. No migration applied. No `schema_migrations` change. No secret printed, rotated, or deleted. No RLS lowered, no grant widened.** Work stops at a clean, pushed, CI-green stacked Draft PR (#46).

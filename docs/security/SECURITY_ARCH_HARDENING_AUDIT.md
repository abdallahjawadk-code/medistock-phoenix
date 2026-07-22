# Security & Architecture Hardening — Audit & Fix Package

**Branch:** `feat/phoenix-security-arch-hardening` (stacked on PR #45 → PR #44 → `master`)
**Base HEAD:** `239fe00` (PR #45 head, CI-green)
**Date:** 2026-07-22
**Scope:** Read-only audit of the whole app + DB surface, then apply **only** confirmed, safely-fixable findings. **No Production mutation, no merge, no deploy.** No migration, RLS, RPC signature, grant, or schema change.

Migration high-water mark across all branches is **092** (master=087, PR#44 adds 088–090, PR#45 adds 091–092). This package adds **no migration** — none proved necessary.

---

## 1. Findings

Severity reflects confirmed, evidenced exploitability in this codebase — not textbook worst case.

| # | Sev | Area | Finding (evidence) | Impact | Fix | Test | Status |
|---|-----|------|--------------------|--------|-----|------|--------|
| F1 | **Low–Med** | A/E headers | No `Strict-Transport-Security` header. `vercel.json` shipped CSP + XFO + nosniff + Referrer-Policy + Permissions-Policy but **no HSTS**; Vercel does not add it automatically. | First-visit / typed-`http://` request is SSL-strip / MITM-able before the HTTPS redirect. (`upgrade-insecure-requests` already covers subresources, limiting blast radius.) | Added `Strict-Transport-Security: max-age=31536000` to `vercel.json` (host-scoped; no `includeSubDomains`/`preload` to avoid affecting sibling subdomains). | `tests/security-headers-contract.test.ts` — proven to fail on pre-fix `vercel.json`, pass after. | **FIXED** |
| F2 | **Low (guard gap)** | D DB | No regression guard that **every** `SECURITY DEFINER` function pins `search_path`. Audit confirmed 171/171 currently pin it, but nothing prevented a future migration from omitting it (CWE-426 / Supabase "Function Search Path Mutable"). | A future unpinned definer function referencing unqualified objects would be a privilege-escalation vector, silently. | No code change needed — the invariant already holds. Added a durable guard. | `tests/definer-search-path-guard.test.ts` — parses all migrations, resolves each function's final definition, asserts all definers pin `search_path`. | **FIXED (guard added)** |
| F3 | **Low** | A/E headers | No regression guard that the security headers themselves stay present/strong in `vercel.json`. | A future edit could silently drop CSP/XFO/HSTS with no runtime error. | Guard only. | `tests/security-headers-contract.test.ts` asserts presence + security-relevant shape (script-src has no `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`, HSTS ≥ 1y). | **FIXED (guard added)** |

### Deferred (confirmed but not safely fixable inside this additive, contract-preserving package)

| # | Sev | Area | Finding | Why deferred | Containment |
|---|-----|------|---------|--------------|-------------|
| D1 | **Med** | B auth | **TOCTOU on the "last active super_admin" guard.** `admin-user-lifecycle` and `admin-recycle-user`/`admin-create-user` count active super_admins then act; two concurrent `disable`/`delete` calls targeting two different super_admins can each read count=2 and both proceed → zero active super_admins. Evidence: `supabase/functions/admin-user-lifecycle/index.ts` `isLastActiveSuperAdmin()` (L173–181) reads then acts non-atomically. | A correct fix requires serializing the check+action under a shared DB lock (advisory lock or a guarded RPC) — that changes the account-lifecycle **contract** and touches Edge Functions, which deploy manually and out of this PR's build. Per gate #4 ("stop and ask on ambiguity"), this needs an owner decision. | **Availability-only** (admin lockout), fully recoverable by the platform owner via direct DB/`auth` access; requires ≥2 super_admins **and** precise concurrent requests. Recommend a follow-up: `phoenix_guard_last_super_admin()` SECURITY DEFINER RPC taking `pg_advisory_xact_lock` around the count+ban. |
| D2 | **Low** | B auth | **User-existence oracle for `institution_admin`.** Lifecycle/recycle return distinct `TARGET_NOT_FOUND` (404) vs `CROSS_ORG_FORBIDDEN` (403) vs `INSUFFICIENT_PERMISSION` (403) before confirmation, letting a privileged `institution_admin` probe existence/cross-org membership of arbitrary UUIDs. | Fix means reordering/uniforming error responses in Edge Functions (contract-visible strings the frontend switches on). Behavior change to the auth contract — owner decision. | Actor is already privileged; targets are **UUIDs** (not enumerable). Low practical value. Recommend collapsing to a single `TARGET_UNAVAILABLE` for the institution_admin path in the follow-up. |
| D3 | **Low/Info** | B auth | Edge Functions set `Access-Control-Allow-Origin: '*'`. | Functions are **Bearer-token** authed (no cookies), so `*` grants no CSRF/credential-theft path; a stolen token is the prerequisite regardless of origin. Restricting origins risks breaking Vercel **preview** deployments (dynamic hostnames). | Defense-in-depth only. Recommend an allowlist keyed off a configured app-origin env var in the follow-up, once preview-origin policy is decided. |

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
| `lint` (CI `--max-warnings 4`) | 4 warnings = baseline (new tests live in `tests/`, outside lint scope) |
| `build` | success |
| full test suite | 10735 passed (+9 new), 101 skipped |
| new guard tests | 9 passed; HSTS guard proven to fail pre-fix |
| npm audit (`--audit-level=moderate`) | 0 vulnerabilities |
| bundle secret scan | clean |

**Known local-only non-failures (pass on CI, per repo convention):**
1. `authz-security-scan` `premium-preview.html` guard — CI fabricates that file (`install -m 600 /dev/null`); it is absent locally.
2. Intermittent `git diff -- …StatusCenterScreen.tsx` "Could not access" under vitest parallel workers — git contention (verified: the 5 affected files pass when run serially). Absent on CI's isolated checkout.

## 4. Rollback & later activation

- **Rollback:** revert this branch's commits; there is nothing else to undo — no migration applied, no schema/grant/RLS change, no deploy. `vercel.json` header revert is a one-line diff.
- **Activation:** the HSTS header takes effect automatically on the next Vercel deploy of a branch that includes it (no manual step). The two guard tests are active in CI immediately.

## 5. Explicit confirmation

**No Production mutation. No merge. No deploy. No `schema_migrations` change. No secret printed, rotated, or deleted.** Work stops at a clean, pushed, CI-green stacked Draft PR.

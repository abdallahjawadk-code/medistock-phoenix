# MediStock Phoenix V2 — Final Delivery Report (Live Wiring)

**Date:** 2026-06-27
**Project ref:** `eyrzxgfkvqybjdgyphap`
**Repo:** `C:\Users\abdal\OneDrive\Desktop\phoenix` (separate from the legacy app)
**Design source of truth:** `design-source/MediStock-Babil.dc.html`

This report covers the **finalization / live-wiring** pass performed after the
clean schema rebuild. The destructive wipe was **not** re-run in this pass.

---

## 1. Scope of this pass

Before this pass the Phoenix app was a static design prototype: the service layer
existed and queried the Phoenix tables, but **no screen consumed it**, login was a
local demo role-picker, and there was no session/auth wiring.

This pass implemented real authentication and wired every screen to live data.

---

## 2. What was built

### Auth + session
- `src/shared/supabase/services/auth.service.ts` — `signIn` (email/password),
  `signOut`, `getSession`, `onAuthChange`, `getMyProfile` (anon key only).
- `src/app/AppContext.tsx` — real `session` + `profile` + `authReady` gating,
  role derived from `public.profiles`, runtime org-scope selector.
- `src/app/App.tsx` — auth gate (session required) + anon public-QR route (`?qid=`).
- `src/features/auth/LoginScreen.tsx` — real email/password sign-in, loading +
  safe error states, config-missing banner. Demo role-picker removed.

### New components
- `src/features/qr/PublicQrScreen.tsx` — anon QR scan view via
  `get_public_qr_payload`; shows public-safe data only.
- `src/shared/ui/PhoenixOrgScope.tsx` — org-scope dropdown (super_admin) / pinned
  chip (other roles).
- `src/shared/lib/useAsync.ts` — loading/error/data hook; logs dev-safe errors,
  never hides Supabase failures.

### Screens wired to live services
| Screen | Source |
|--------|--------|
| Dashboard | `getDashboardMetrics`, `getInstitutionOverviews` |
| Mesh | `getInstitutionOverviews` |
| Mobile Command | `getDashboardMetrics`, `getInstitutionOverviews` |
| Registry | `getLocalItems` (org-scoped) |
| Availability Editor | `getPointsByOrg`, `getLocalItems`, `upsertAvailability` |
| QR Hub | `getQrTokensByOrg`, `disableQrToken` |
| Public QR | `getPublicQrPayload` (anon) |
| Reports | metrics + `getLowStockItems` + `getInstitutionOverviews` + `getAuditLog` |

Every wired screen has loading / empty / error / disabled states.

### Service-layer fixes
- `dashboard.service.ts` — added `getInstitutionOverviews()` (real per-org counts).
- `availability.service.ts` — `condition` now typed to the **exact** DB CHECK values
  (`AvailabilityCondition`), fixing a latent mismatch (`'low'` vs `'low_stock'`).
- `types.ts` — `Role` now mirrors the DB CHECK
  (`super_admin | hospital_admin | warehouse_manager | point_operator | viewer`).

---

## 3. Demo-fallback policy

- Services return **empty arrays / labeled offline mode** when
  `VITE_PHOENIX_SUPABASE_*` is not set (`supabaseConfigured === false`). The login
  and dashboard show a clear "not configured / offline" banner.
- **Removed** all in-component hardcoded production-looking numbers (the old
  `INSTITUTIONS`, `ALERTS`, `PUBLIC_ITEMS`, fake uptimes in Mobile/Dashboard/QR).
- **Kept (labeled demo):** `HealthScreen` module-health visuals — there is no
  health telemetry service yet; the screen is explicitly labeled "Read-only · Demo
  data". Tracked as a follow-up.
- Supabase errors are surfaced via `PhoenixErrorState` (retry) and logged to the
  console for developers — never silently swallowed.

---

## 4. Security / guardrails

PowerShell-equivalent scans over `src/` — **zero real findings** (only the
guardrail test file references the banned tokens, by design):

- no `service_role` / `SERVICE_ROLE` / `DATABASE_URL` / `PHOENIX_DATABASE_URL`
- no raw `.from(...).delete(...)` on any table
- no `DataReset` / OCR / DocIntel / Excel / PharmaNetwork / SmartIntake modules
- QR-only actions use RPCs (`disable_qr_token`) and never mutate the parent
- archive/purge remain RPC-only, allowlisted, QR-first / parent-last, super_admin
  purge with exact confirmation phrase (migration 003, unchanged)
- `.env.local` is gitignored and not staged

Guardrail tests extended: now **462 tests** (added live-auth, app-routing, and
QR-RPC sections).

---

## 5. Verification results (this pass)

| Check | Command | Result |
|-------|---------|--------|
| Tests | `npm test` | ✅ 462 passed |
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Lint | `npm run lint` | ✅ 0 warnings (`--max-warnings 0`) |
| Build | `npm run build` | ✅ built (`index` 90.6 kB, `vendor` 140.7 kB, `supabase` 212.4 kB) |
| Audit | `npm audit --audit-level=high` | ⚠️ dev-only chain (see §6) |

---

## 6. Audit — remaining vulnerabilities (dev-only)

`npm audit`: **5 vulnerabilities (3 moderate, 1 high, 1 critical)** — all in the
**dev toolchain**, none in the production bundle:

| Package | Severity | Issue | Ships to prod? |
|---------|----------|-------|----------------|
| esbuild | moderate | dev server can be probed by any site (GHSA-67mh-4wv8-2f99) | No (dev server only) |
| vite | high | path traversal in optimized deps / `server.fs.deny` bypass / launch-editor NTLM | No (dev server only) |
| vitest | critical | Vitest **UI** server arbitrary file read/exec | No (we never run `--ui`; CI/test only) |
| vite-node, @vitest/mocker | moderate | transitive via vite | No |

**Mitigation:** the only fix is `vite@8` / `vitest@3`, a **major breaking** upgrade.
Per policy we did **not** run `npm audit fix --force`. `npm audit fix` (non-breaking)
is a no-op here. The production deployment is a static bundle on Vercel — the Vite
dev server and Vitest UI are never deployed, so production exposure is **none**.
Re-evaluate the Vite 6/7/8 upgrade as a dedicated, tested follow-up.

---

## 7. Remaining manual items (require live DB / owner action)

1. **Create/confirm super_admin** — run `full-wipe/03-create-super-admin-final.md`
   in the Supabase SQL Editor (confirm the Auth email first). Could not be done from
   the build agent (no privileged DB access).
2. **Fill `.env.local`** with `VITE_PHOENIX_SUPABASE_URL` + `VITE_PHOENIX_SUPABASE_ANON_KEY`
   (and Vercel env vars) — anon key only.
3. **Live smoke test** — sign in, load dashboard, scan a QR (`/?qid=…`), save an
   availability record, view audit log. Live-data verification depends on items 1–2.
4. **HealthScreen** — wire to a real telemetry source or keep the demo label.

---

## 8. Deployment & password reset (added 2026-06-27)

### Password reset flow (code — done)
- `auth.service.ts`: `requestPasswordReset(email)` →
  `resetPasswordForEmail(email, { redirectTo: ${origin}/auth/callback })`;
  `updatePassword(newPassword)` → `updateUser({ password })`. Anon key only, no
  hardcoded legacy URL.
- `AppContext`: tracks `PASSWORD_RECOVERY` (and `/auth/callback` / `type=recovery`
  in the URL) → `passwordRecovery` flag; `clearRecovery()` returns to login.
- `App.tsx`: routes to the new **Set New Password** screen on recovery, before the
  session gate.
- `LoginScreen`: added **Forgot password?** → request-reset sub-form with a generic
  "check your email" confirmation (no account enumeration).
- New `ResetPasswordScreen.tsx`: set-new-password with validation (min 8, match).
- `vercel.json`: SPA rewrites so `/auth/callback` + `/login` serve the app.

Guardrails extended to **474 tests** (reset uses dynamic origin redirect; no `src`
file hardcodes `medistock-qr-network`).

### Deployment (manual — agent has no Vercel/Supabase access)
- **Vercel:** no CLI/token here → cannot deploy/repoint/archive/delete. Runbook:
  [`12-vercel-replace-legacy.md`](12-vercel-replace-legacy.md).
- **Supabase Auth URLs:** no admin API here → cannot set Site/Redirect URLs.
  Runbook: [`13-supabase-auth-redirects.md`](13-supabase-auth-redirects.md).
- **Final production URL:** TBD by operator (reuse `medistock-qr-network.vercel.app`
  or a new Phoenix URL).
- **Legacy Vercel project:** not touched — archive/disable after Phoenix verified;
  delete only with explicit approval.

### Rollback
- Frontend: re-promote the previous Vercel deployment / re-attach the domain to the
  legacy project (legacy source untouched at the old project dir).
- Auth: revert Supabase Site/Redirect URLs to the legacy URL.
- DB: not involved — never re-run the wipe.

---

## 9. Status

```
LIVE_WIRING_COMPLETE + RESET_FLOW_COMPLETE — code/tests/build green (474 tests).
Manual (operator): deploy to Vercel, set Supabase Auth URLs, create super_admin,
fill .env, live smoke test  →  USER_SMOKE_TEST_PENDING.
Destructive wipe was NOT re-run.
```

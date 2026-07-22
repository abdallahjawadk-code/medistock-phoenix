# Deployment Readiness — MediStock-Babil Phoenix V2

Production deployment checklist for `medistock-phoenix`.
Hosting: **Vercel** (frontend) + **Supabase** (database/auth).

> This document is readiness-only. **Do not deploy** until a deploy phase is
> explicitly approved. Deployment is performed by pushing to GitHub `master`
> (Vercel auto-builds) — never with `vercel --prod` directly.

> 🚫 **OPEN HARD BLOCKER — do not deploy.** The manual warehouse
> accumulating-receipt path can silently double-post the ledger across devices.
> It is fail-closed in production builds by `warehouse-intake-safety.ts` until a
> server expected-generation precondition lands. See
> [`blocker-migration-065-accumulating-receipt-concurrency.md`](blocker-migration-065-accumulating-receipt-concurrency.md).

---

## 1. Required Vercel environment variables

Set these in **Vercel → Project → Settings → Environment Variables**
(Production, and Preview if used). The frontend reads **only** `VITE_`-prefixed
vars; Vite never exposes non-`VITE_` vars to the browser.

| Variable | Scope | Notes |
|----------|-------|-------|
| `VITE_PHOENIX_SUPABASE_URL` | Frontend (browser) | Supabase project URL (e.g. `https://<ref>.supabase.co`) |
| `VITE_PHOENIX_SUPABASE_ANON_KEY` | Frontend (browser) | Supabase **anon** public key — **never** the service_role key |

Rules:
- ❌ **Never** put `service_role` in any `VITE_` variable or anywhere the
  frontend can read it. The app uses the **anon key only**; all privileged
  operations go through RLS-protected tables and `security definer` RPCs.
- ❌ **Never** commit `.env.local` (already in `.gitignore`).
- ❌ **Never** document or commit real secret values.
- ✅ If both vars are missing/empty the app degrades to a safe **offline mode**
  (`supabaseConfigured === false`) rather than crashing — but production needs
  them set for the app to function.

> ⚠️ Variable **names matter**. The code reads exactly
> `VITE_PHOENIX_SUPABASE_URL` and `VITE_PHOENIX_SUPABASE_ANON_KEY`
> (see `src/shared/supabase/client.ts`). Generic names like
> `VITE_SUPABASE_URL` will **not** be picked up and the app will run offline.

---

## 2. Vercel project settings

| Setting | Value |
|---------|-------|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` (default) |
| Node version | 18+ (compatible with Vite 5 / current `package.json`) |

`vercel.json` is committed and already correct:
- `framework: "vite"`, `buildCommand: "npm run build"`, `outputDirectory: "dist"`
- SPA rewrite `"/(.*)" → "/index.html"` so client-side routes and public-QR
  deep links resolve on hard refresh.

No `vercel.json` change is required.

---

## 3. Required manual Supabase migrations

Apply **manually** via the Supabase SQL Editor — **never** `npx supabase db push`.
See `docs/manual-supabase-migrations.md` for full SQL smoke tests.

Order and steps:

1. **Back up Supabase first** (Dashboard → Database → Backups, or `pg_dump`).
2. **Apply 005 manually** — `005_phoenix_assign_profile_role.sql`
   - Smoke test: role-assignment RPC exists; anon has no execute; a
     `hospital_admin` cannot escalate to `super_admin`.
3. **Apply 006 manually** — `006_phoenix_status_reports.sql`
   - Smoke test: `institution_item_status_reports` table exists with RLS on;
     insert + read a status report within an org.
4. **Apply 007 manually** — `007_phoenix_clear_port_availability.sql`
   - Smoke test: `clear_port_availability` RPC exists; wrong confirmation
     returns `CONFIRMATION_MISMATCH`; a correct call clears only
     `item_availability` for that point (port + QR untouched).
5. **Verify public QR still works** after migrations.
6. **Verify RLS** with both a `super_admin` and a `hospital_admin` session if
   credentials exist (admin sees all; hospital_admin scoped to own org).

---

## 4. Build & quality gates (must pass before deploy)

```
npm test -- --run        # 690 tests, exit 0
npm run typecheck        # exit 0
npm run lint             # exit 0 (max-warnings 0)
npm run build            # exit 0 — see acceptable warning below
npm audit --audit-level=high
```

### Known acceptable warnings
- **`Generated an empty chunk: "qr"`** during `vite build`. The
  `qr` manualChunk in `vite.config.ts` ends up empty because `qrcode` is not
  statically imported into the main graph. Harmless; build exit code is **0**.
- **`npm audit`** reports pre-existing **dev-only** vulnerabilities in the
  `esbuild → vite → vitest / vite-node / @vitest/mocker` chain. These are build
  tooling, not shipped to production. **Do not** run `npm audit fix --force`
  (it forces a breaking `vite@8` upgrade). Revisit as a separate, reviewed
  dependency-upgrade task.

---

## 5. Route protection summary

| Route / view | Access | Notes |
|--------------|--------|-------|
| Public QR (`?qid=…` or `?token=…`) | **Public (no auth)** | Resolved before the session gate in `App.tsx`. Shows only the scanned port's item name/condition/quantity/expiry. No tokens, internal IDs, user data, audit logs, notes, or admin controls. Revoked/invalid QR shows a safe inactive message. |
| Password recovery (`type=recovery`) | Public link | From Supabase reset email; takes priority over the app. |
| Dashboard | Auth-gated | Renders only when `session` exists. |
| Institutions / deletion wizard | Auth-gated | Role-scoped; destructive actions need role + confirmation. |
| Status Center | Auth-gated | Role/org-scoped. |
| Role management | Auth-gated | Server-enforced via `assign_profile_role` RPC. |

No protected data is reachable before login except the public QR page.

**Local username credentials (LOCAL-CREDENTIALS-MODE-A):** the login screen
accepts a username OR a real email. Bare usernames are resolved to a
synthetic, non-deliverable internal email (`<username>@local.medistock.invalid`)
before calling Supabase Auth — see `docs/account-lifecycle-policy.md` §3.4.
Local accounts never depend on SMTP/email delivery to be created, recovered,
or logged into.

---

## 6. RTL / LTR readiness
- Arabic → RTL, English → LTR; `dir` synced on `<html>` and `<body>`
  (`src/app/AppContext.tsx`).
- Sidebar and mobile drawer mirror by direction.
- Public QR page is bilingual and safe in both directions; user text uses
  `dir="auto"`, technical strings (URLs, dates) use `dir="ltr"`.
- No horizontal overflow at 320px / 390px.

---

## 7. Post-deploy smoke tests

Run against the live deployment after each deploy:

1. Log in as `super_admin`.
2. Dashboard loads (real metrics, no demo data).
3. Institutions page loads.
4. Role assignment works (requires **005** applied).
5. Create a distribution point (port).
6. Generate its QR.
7. Open the public QR URL (unauthenticated / incognito).
8. Add port availability items.
9. Public QR page shows **only that port's** items.
10. Add a central status report (requires **006** applied).
11. Exchange recommendations appear when scarce/surplus reports match.
12. Clear port availability (requires **007** applied) — port + QR remain.
13. Archive a port safely (QR revoked first, then archived).
14. Verify Arabic RTL.
15. Verify English LTR.
16. Verify mobile at 390px (and 320px) — no horizontal overflow.

---

## 8. Rollback plan

- **Git**: `git revert <commit_hash>` then push to `master` (Vercel rebuilds).
- **Vercel**: promote the previous successful deployment from the Vercel
  dashboard (Deployments → ⋯ → Promote to Production / Rollback).
- **Supabase**: manual SQL rollback **only** if a reviewed down-script exists
  (see rollback section in `docs/manual-supabase-migrations.md`). Restore from
  the pre-migration backup when in doubt.
- **Preference**: disable/hide a UI feature over a destructive DB rollback
  whenever possible.

---

## 9. Known deferred / intentionally-absent features
- Intake / Excel import / OCR / DocIntel — **frozen** (see `IntakeFrozenScreen`).
- Data Reset Center — **absent** (intentionally not restored).
- Transfer workflow, approval workflow, AI, offline-first — not implemented.
- `purge_entity_with_all_data` hard purge — exists server-side
  (super_admin + confirmation gated) but is **not wired into any UI screen**.

---

## 10. Pre-deploy manual actions checklist
- [ ] Apply / confirm migration **005**.
- [ ] Apply / confirm migration **006**.
- [ ] Apply / confirm migration **007**.
- [ ] Set `VITE_PHOENIX_SUPABASE_URL` and `VITE_PHOENIX_SUPABASE_ANON_KEY` in Vercel.
- [ ] Verify the Git author email is the GitHub-verified account email.
- [ ] Push `master` to GitHub (the readiness commit is local until pushed).

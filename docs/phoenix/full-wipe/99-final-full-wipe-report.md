# MediStock Phoenix V2 — Full Wipe & Rebuild Report

**Date:** 2026-06-27  
**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Branch:** phoenix-v2-clean-core  
**Status:** READY — awaiting `FULL_PUBLIC_APP_WIPE_APPROVED=yes` for destructive execution

---

## 1. Backup Status

| Item | Status |
|------|--------|
| Backup instructions created | ✓ `docs/phoenix/full-wipe/00-backup-before-full-wipe.md` |
| `pg_dump` command documented | ✓ |
| Restore command documented | ✓ |
| `PHOENIX_DATABASE_URL` filled in | ⚠️ PENDING — user must add DB password to `.env.local` |
| Actual backup file created | ⚠️ PENDING — cannot run without `PHOENIX_DATABASE_URL` |

---

## 2. Full Wipe Status

| Item | Status |
|------|--------|
| `FULL_PUBLIC_APP_WIPE_APPROVED` | ⛔ EMPTY — wipe NOT executed |
| Wipe SQL generated | ✓ `supabase/full_wipe_tools/000_full_public_app_wipe.sql` |
| Wipe SQL has safety checks | ✓ Checks database name + auth/storage/extensions still present |
| Wipe SQL drops public CASCADE | ✓ (blocked until approved) |
| Wipe SQL recreates public | ✓ |
| Wipe SQL restores grants | ✓ anon, authenticated, service_role, postgres |
| Wipe SQL does NOT touch auth | ✓ |
| Wipe SQL does NOT touch storage | ✓ |

**BLOCKED_WAITING_FOR_FULL_PUBLIC_APP_WIPE_APPROVAL**  
To unblock: set `FULL_PUBLIC_APP_WIPE_APPROVED=yes` in `.env.local` and run `000_full_public_app_wipe.sql` in Supabase SQL Editor.

---

## 3. Phoenix Schema Status

| Migration | File | Status |
|-----------|------|--------|
| 001 Core schema (10 tables) | `supabase/migrations/001_phoenix_core_schema.sql` | ✓ Generated, not applied |
| 002 RLS policies (35+ policies) | `supabase/migrations/002_phoenix_rls_policies.sql` | ✓ Generated, not applied |
| 003 RPC lifecycle (6 RPCs) | `supabase/migrations/003_phoenix_rpc_lifecycle.sql` | ✓ Generated, not applied |
| 004 Demo seed data | `supabase/migrations/004_phoenix_seed_demo_data.sql` | ✓ Generated, not applied |

---

## 4. RLS Status

| Table | RLS | Anon read | SA write | HA write | Viewer |
|-------|-----|-----------|----------|----------|--------|
| organizations | ✓ | ✗ | ✓ | own org | read own |
| profiles | ✓ | ✗ | ✓ | own org | read own |
| warehouses | ✓ | ✗ | ✓ | own org | read own |
| distribution_points | ✓ | ✗ | ✓ | own org | read own |
| central_items | ✓ | ✗ | ✓ only | ✗ | read |
| local_items | ✓ | ✗ | ✓ | own org | read own |
| item_availability | ✓ | ✓ read | ✓ | own org | read own |
| qr_targets | ✓ | ✗ | ✓ | own org | read own |
| qr_tokens | ✓ | active only | ✓ | own org | read own |
| audit_logs | ✓ | ✗ | read all | read own | ✗ |

---

## 5. RPC Status

| RPC | Purpose | Anon | Auth | Super only |
|-----|---------|------|------|-----------|
| `get_public_qr_payload` | QR scan result | ✓ | ✓ | ✗ |
| `create_qr_for_target` | Create QR token | ✗ | ✓ | ✗ |
| `disable_qr_token` | Disable QR (never touches parent) | ✗ | ✓ | ✗ |
| `archive_entity` | Soft-archive (allowlist: wh/dp/li) | ✗ | ✓ | ✗ |
| `get_entity_purge_impact` | Preview before purge | ✗ | ✓ | ✗ |
| `purge_entity_with_all_data` | Hard-delete (QR-first, parent-last) | ✗ | ✓ | ✓ |

---

## 6. Seed Data Status

| Entity | Count | Status |
|--------|-------|--------|
| Organizations | 2 | ✓ In 004 migration |
| Warehouses | 2 | ✓ |
| Distribution points | 4 | ✓ |
| Central items | 8 | ✓ |
| Local items | 4 | ✓ |
| Availability records | 8 (mix of all conditions) | ✓ |
| QR targets | 2 | ✓ |
| QR tokens | 2 (demo public_ids) | ✓ |
| Audit log entries | 3 | ✓ |

---

## 7. Admin Access Status

| Item | Status |
|------|--------|
| Auth users protected during wipe | ✓ |
| Admin profile creation SQL | ✓ `supabase/full_wipe_tools/create_first_admin_profile.sql` |
| Admin access doc | ✓ `docs/phoenix/full-wipe/02-admin-access-after-wipe.md` |
| Admin profile actually created | ⚠️ PENDING — user must run SQL with their real auth user UUID |

---

## 8. Frontend Wiring Status

| Service | File | Status |
|---------|------|--------|
| Supabase client | `src/shared/supabase/client.ts` | ✓ Lazy init, supabaseConfigured flag |
| Dashboard metrics | `services/dashboard.service.ts` | ✓ Demo fallback |
| Organizations | `services/organizations.service.ts` | ✓ Demo fallback |
| Availability | `services/availability.service.ts` | ✓ Demo fallback |
| Warehouses + points | `services/warehouses.service.ts` | ✓ Demo fallback |
| Registry (central items) | `services/registry.service.ts` | ✓ Demo fallback |
| QR | `services/qr.service.ts` | ✓ Demo fallback |
| Audit log | `services/audit.service.ts` | ✓ Demo fallback |
| Lifecycle (archive/purge) | `services/lifecycle.service.ts` | ✓ No demo fallback (destructive ops) |

**Note:** Services are wired to real Supabase when `VITE_PHOENIX_SUPABASE_ANON_KEY` is set. Until then, screens use hardcoded demo data.

---

## 9. Test Results

```
✓ 409 tests passed (0 failed)
  - Full wipe SQL safety (6 tests)
  - Migration 001: 10 tables (12 tests)
  - Migration 002: RLS enabled (12 tests)
  - Migration 003: Purge safety (8 tests)
  - Frontend: no service_role (per-file)
  - Frontend: no .delete() on tables (per-file)
  - Frontend: no old project imports (per-file)
  - Package.json: no dangerous scripts (2 tests)
  - Supabase client: lazy init (3 tests)
  - AppContext: RTL/LTR direction (2 tests)
  - IntakeFrozenScreen: frozen state (2 tests)
```

---

## 10. Build Result

```
✓ tsc -b — zero TypeScript errors
✓ vite build — 54 modules transformed, built in 2.45s
  dist/assets/index.js:    85.21 kB (gzip: 18.66 kB)
  dist/assets/vendor.js:  140.74 kB (gzip: 45.21 kB)
  dist/assets/index.css:    2.65 kB (gzip:  1.14 kB)
```

---

## 11. Verification SQL

`supabase/full_wipe_tools/verify_phoenix_after_full_wipe.sql` — checks:
- 10 Phoenix tables exist
- RLS enabled on all 10
- Required triggers present
- 6 RPCs present
- Purge V1 marker present
- Old legacy tables are gone
- Old broken RPCs are gone
- Seed data counts correct
- Supabase internal schemas (auth, storage, extensions) still exist

Expected output after full rebuild: `OK_FULL_WIPE_PHOENIX_READY`

---

## 12. Vercel Deployment

| Item | Status |
|------|--------|
| Staging deployment doc | ✓ `docs/phoenix/05-staging-deployment.md` |
| Production cutover doc | ✓ `docs/phoenix/06-production-cutover.md` |
| Actual Vercel deployment | ⚠️ PENDING — requires env vars + repo push |

---

## 13. Rollback Plan

1. Restore from `backups/phoenix-full-wipe/YYYYMMDD_HHMMSS_pre_wipe.sql`
2. Old frontend remains at `C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project` — never touched
3. Rebuild old frontend: `npm run build` from old project dir

---

## 14. Known Risks

| Risk | Mitigation |
|------|------------|
| npm audit: 1 high (esbuild dev server) | Dev-only vulnerability; does not affect production build. Do NOT use `--force`. Mitigate by upgrading Vite when a non-breaking fix is available. |
| VITE_ env vars missing → demo-only mode | Expected: app works in demo mode. Fill `.env.local` to switch to live mode. |
| Old QR public_ids become invalid after wipe | Expected. Old QR codes must be reprinted after wipe. New seed has `demo-qr-emergency-01`. |
| PostgREST cache may hold old RPC signatures | After wipe, restart Supabase project from dashboard if RPCs behave unexpectedly. |

---

## 15. SQL Files to Apply (Manual, in Order)

After setting `FULL_PUBLIC_APP_WIPE_APPROVED=yes` and completing backup:

```
1. supabase/full_wipe_tools/000_full_public_app_wipe.sql
2. supabase/migrations/001_phoenix_core_schema.sql
3. supabase/migrations/002_phoenix_rls_policies.sql
4. supabase/migrations/003_phoenix_rpc_lifecycle.sql
5. supabase/migrations/004_phoenix_seed_demo_data.sql
6. supabase/full_wipe_tools/create_first_admin_profile.sql  (edit UUID first)
7. supabase/full_wipe_tools/verify_phoenix_after_full_wipe.sql  → must return OK
```

All applied via **Supabase SQL Editor** only. Not via `npx supabase db push`.

---

## 16. Visual Verification

- Login screen: ✓ RTL Arabic, role chips, trust badges, animated blobs
- Dashboard (desktop): ✓ 8 metric cards, sticky topbar, Demo Data badge
- Dashboard (mobile 375px): ✓ 2×2 grid, bottom nav, no overflow
- Dark mode: ✓ Navy theme, correct contrast
- Build: ✓ Zero errors

---

## FINAL STATUS

```
BLOCKED_WAITING_FOR_FULL_PUBLIC_APP_WIPE_APPROVAL

All files generated. All tests passing. Build clean.
Destructive wipe has NOT been executed.

To proceed:
  1. Fill PHOENIX_SUPABASE_ANON_KEY in .env.local
  2. Fill PHOENIX_DATABASE_URL in .env.local
  3. Run pg_dump backup
  4. Set FULL_PUBLIC_APP_WIPE_APPROVED=yes
  5. Apply SQL files in order via Supabase SQL Editor
  6. Run verify_phoenix_after_full_wipe.sql → expect OK_FULL_WIPE_PHOENIX_READY
```

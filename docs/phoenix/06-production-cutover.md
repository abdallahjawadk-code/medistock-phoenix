# Phoenix V2 — Production Cutover

**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Created:** 2026-06-27

---

## Cutover Strategy

This is a **same-Supabase-project** migration. The public schema is wiped and rebuilt.  
The old frontend project remains untouched at:  
`C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project`

---

## Phase Gate Checklist

Complete ALL of these before cutover:

### Backend Gates
- [ ] Full backup completed (see `docs/phoenix/full-wipe/00-backup-before-full-wipe.md`)
- [ ] `inspect_public_before_wipe.sql` run and results saved
- [ ] `FULL_PUBLIC_APP_WIPE_APPROVED=yes` set in `.env.local`
- [ ] `000_full_public_app_wipe.sql` applied (via SQL Editor)
- [ ] `001_phoenix_core_schema.sql` applied
- [ ] `002_phoenix_rls_policies.sql` applied
- [ ] `003_phoenix_rpc_lifecycle.sql` applied
- [ ] `004_phoenix_seed_demo_data.sql` applied
- [ ] `create_first_admin_profile.sql` applied (real admin UUID inserted)
- [ ] `verify_phoenix_after_full_wipe.sql` returns `OK_FULL_WIPE_PHOENIX_READY`

### Frontend Gates
- [ ] `npm run typecheck` — zero errors
- [ ] `npm test -- --run` — all guardrail tests pass
- [ ] `npm run build` — clean build, no warnings
- [ ] `npm audit --audit-level=high` — zero high severity vulnerabilities
- [ ] Visual verification: login, dashboard, QR scan work in staging
- [ ] Mobile layout verified at 375px
- [ ] Dark mode verified
- [ ] RTL/LTR toggle verified

### Access Gates
- [ ] At least one `super_admin` profile exists and can log in
- [ ] Supabase allowed origins updated for production URL

---

## Cutover Execution Order

1. **Maintenance window start** — notify users
2. **Final backup** — run `pg_dump` one more time
3. **Apply wipe** — `000_full_public_app_wipe.sql` via SQL Editor
4. **Apply migrations** — 001 → 002 → 003 → 004 in order
5. **Create admin profile** — `create_first_admin_profile.sql`
6. **Run verification** — `verify_phoenix_after_full_wipe.sql` → must return `OK`
7. **Deploy frontend** — push to Vercel / update env vars
8. **Smoke test** — login as super_admin, check dashboard, scan a QR
9. **Maintenance window end**

---

## Rollback Plan

If something goes wrong after the wipe:

1. **Restore the backup**:
   ```bash
   psql "$PHOENIX_DATABASE_URL" \
     --file="backups/phoenix-full-wipe/YYYYMMDD_HHMMSS_pre_wipe.sql"
   ```

2. **Point the old frontend back at Supabase** — the old project is untouched at:
   `C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project`

3. **Rebuild old frontend**:
   ```bash
   cd "C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project"
   npm run build
   ```

4. **Deploy old frontend** to same hosting slot

---

## Known Risks

| Risk | Mitigation |
|------|------------|
| pg_dump backup fails | Use Supabase dashboard backup first |
| Auth users lose sessions post-wipe | They can re-login; sessions are in `auth` not `public` |
| Missing profiles after wipe | `create_first_admin_profile.sql` handles this |
| Old Supabase RPCs cached by PostgREST | After wipe, PostgREST auto-reloads (restart project if needed) |
| Vercel env vars not updated | Update before pointing DNS to Phoenix |
| QR scan URLs from old system | Old public_ids will 404 after wipe; QR codes must be reprinted |

---

## Post-Cutover Monitoring (First 24h)

- Check Supabase Dashboard → Logs → API for 4xx/5xx errors
- Monitor `audit_logs` table for unexpected actions
- Verify availability editor saves correctly
- Verify QR scan returns correct data

---

## Data NOT Migrated

The following old data is intentionally dropped and not migrated:
- OCR import batches
- Excel import batches
- Document intelligence batches
- Pharma network records
- Transfer alerts
- Old purge audit trail

If any of this data is needed, restore from the pre-wipe backup file.

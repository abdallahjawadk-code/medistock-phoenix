# Backup Before Full Public App Wipe

**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Created:** 2026-06-27  
**Status:** REQUIRED — complete all steps before proceeding

---

## ⚠️ WARNING

This wipe removes **everything** in the Supabase `public` schema:
- All tables and their data
- All views, functions, triggers, policies
- All indexes owned by app objects

**Not removed:** `auth`, `storage`, `realtime`, `extensions`, `vault`, `graphql`, Supabase auth users.

---

## Step 1 — Supabase Dashboard Backup (Recommended First)

1. Go to [https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/settings/general](https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/settings/general)
2. Scroll to **Backups** section
3. Click **Download latest backup** (if on Pro/Team plan)
4. Save the `.sql.gz` file to a safe location outside the project

---

## Step 2 — Manual `pg_dump` Backup

### Get your database URL
From Supabase Dashboard → Settings → Database → Connection string (URI format).  
It looks like: `postgresql://postgres.eyrzxgfkvqybjdgyphap:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres`

Add it to `.env.local`:
```
PHOENIX_DATABASE_URL=postgresql://postgres.eyrzxgfkvqybjdgyphap:YOUR_PASSWORD@...
```

### Run the backup
```bash
# Create backup directory (do not commit this)
mkdir -p backups/phoenix-full-wipe

# Dump only the public schema (app layer)
pg_dump \
  --schema=public \
  --no-owner \
  --no-privileges \
  --format=plain \
  --file="backups/phoenix-full-wipe/$(date +%Y%m%d_%H%M%S)_pre_wipe.sql" \
  "$PHOENIX_DATABASE_URL"

echo "Backup complete."
```

### What this captures
- All public tables + data
- All public functions + RPCs
- All public triggers and views
- Does NOT include auth.users (safe)

---

## Step 3 — Restore Command (if rollback needed)

```bash
# Restore from backup (run ONLY if something goes wrong)
psql "$PHOENIX_DATABASE_URL" \
  --file="backups/phoenix-full-wipe/YYYYMMDD_HHMMSS_pre_wipe.sql"
```

Replace `YYYYMMDD_HHMMSS` with the actual filename from Step 2.

---

## Step 4 — Rollback Point

If the wipe succeeds but Phoenix schema has errors:

1. The backup file is your restore point
2. Re-run the restore command above
3. Re-enable the old frontend (old project is untouched at `C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project`)
4. The old project still has its own build at any time

---

## Step 5 — .gitignore backup directory

Ensure this is in `.gitignore`:
```
backups/
.env.local
*.sql.gz
```

---

## Checklist Before Proceeding

- [ ] Dashboard backup downloaded (if Pro plan)
- [ ] `pg_dump` backup created locally
- [ ] Backup file verified (not zero bytes)
- [ ] `.env.local` has `PHOENIX_DATABASE_URL` filled in
- [ ] You understand: **all public schema data will be permanently removed**
- [ ] Set `FULL_PUBLIC_APP_WIPE_APPROVED=yes` in `.env.local` when ready

---

## BLOCKED_WAITING_FOR_FULL_PUBLIC_APP_WIPE_APPROVAL

The current `.env.local` has `FULL_PUBLIC_APP_WIPE_APPROVED=` (empty).  
No destructive SQL has been executed.

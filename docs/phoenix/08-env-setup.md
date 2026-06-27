# Phoenix Environment Setup

**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Created:** 2026-06-27

---

## 1. Create `.env.local`

Copy `.env.example` to `.env.local`:
```bash
copy .env.example .env.local
```

Fill in the values (never commit `.env.local`).

---

## 2. Get Your Supabase Credentials

### Anon Key
1. [Supabase Dashboard → Project Settings → API](https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/settings/api)
2. Copy the **anon / public** key (NOT the service_role key)
3. Add to `.env.local`:
   ```
   VITE_PHOENIX_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   PHOENIX_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

### Database URL (for psql / pg_dump only)
1. [Supabase Dashboard → Project Settings → Database](https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/settings/database)
2. Scroll to **Connection string** → select **URI**
3. Replace `[YOUR-PASSWORD]` with your database password
4. Add to `.env.local`:
   ```
   PHOENIX_DATABASE_URL=postgresql://postgres.eyrzxgfkvqybjdgyphap:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
   ```

---

## 3. Filled `.env.local` Example

```env
PHOENIX_SUPABASE_PROJECT_REF=eyrzxgfkvqybjdgyphap
PHOENIX_SUPABASE_URL=https://eyrzxgfkvqybjdgyphap.supabase.co
PHOENIX_SUPABASE_ANON_KEY=eyJ...your-anon-key
PHOENIX_DATABASE_URL=postgresql://postgres.eyrzxgfkvqybjdgyphap:YOURPASS@aws-0-eu-central-1.pooler.supabase.com:5432/postgres

VITE_PHOENIX_SUPABASE_URL=https://eyrzxgfkvqybjdgyphap.supabase.co
VITE_PHOENIX_SUPABASE_ANON_KEY=eyJ...your-anon-key

FULL_PUBLIC_APP_WIPE_APPROVED=
```

---

## 4. What Each Variable Does

| Variable | Used By | Purpose |
|----------|---------|---------|
| `VITE_PHOENIX_SUPABASE_URL` | Frontend (browser) | Supabase REST API base URL |
| `VITE_PHOENIX_SUPABASE_ANON_KEY` | Frontend (browser) | Anon auth key for API calls |
| `PHOENIX_SUPABASE_URL` | Scripts / CI | Same URL for non-browser tools |
| `PHOENIX_SUPABASE_ANON_KEY` | Scripts | Same key for scripts |
| `PHOENIX_DATABASE_URL` | psql / pg_dump | Direct DB connection (never in frontend) |
| `FULL_PUBLIC_APP_WIPE_APPROVED` | Wipe script gate | Must be `yes` to allow wipe |

---

## 5. Security Rules

- `VITE_*` vars are **bundled into the JavaScript** served to browsers — only put the anon key here
- The **service_role key** must never be in any `VITE_*` var or committed anywhere
- `PHOENIX_DATABASE_URL` contains your DB password — never commit it
- `.env.local` is in `.gitignore` — never `git add` it explicitly

---

## 6. Demo Mode (no Supabase configured)

If `VITE_PHOENIX_SUPABASE_URL` or `VITE_PHOENIX_SUPABASE_ANON_KEY` are empty:
- `supabaseConfigured` is `false` in `src/shared/supabase/client.ts`
- All service functions return hardcoded demo data
- The app still renders with full demo data at `http://localhost:5174`
- Login works in demo mode (no real auth)

---

## 7. Start Dev Server

```bash
cd C:\Users\abdal\OneDrive\Desktop\phoenix
npm run dev
```

App runs at `http://localhost:5174`

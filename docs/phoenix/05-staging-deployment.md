# Phoenix V2 — Staging Deployment

**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Created:** 2026-06-27

---

## Prerequisites

Before deploying to staging:

- [ ] All 4 migrations applied to Supabase (001 → 002 → 003 → 004)
- [ ] `verify_phoenix_after_full_wipe.sql` returns `OK_FULL_WIPE_PHOENIX_READY`
- [ ] At least one `super_admin` profile created
- [ ] `npm run typecheck` passes (zero errors)
- [ ] `npm test -- --run` passes (all guardrails green)
- [ ] `npm run build` succeeds

---

## Option A — Vercel (Recommended)

### 1. Connect repository
1. Push phoenix directory to a GitHub repo (or create one):
   ```bash
   cd C:\Users\abdal\OneDrive\Desktop\phoenix
   git init
   git add .
   git commit -m "feat: MediStock Phoenix V2 initial build"
   git remote add origin https://github.com/YOUR_ORG/medistock-phoenix.git
   git push -u origin main
   ```

2. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub

3. Set **Root Directory** to `/` (or the phoenix folder path if in a monorepo)

4. Set **Framework Preset** to `Vite`

5. Set **Build Command**: `npm run build`

6. Set **Output Directory**: `dist`

### 2. Add environment variables in Vercel
In Vercel → Project → Settings → Environment Variables, add:

| Key | Value | Env |
|-----|-------|-----|
| `VITE_PHOENIX_SUPABASE_URL` | `https://eyrzxgfkvqybjdgyphap.supabase.co` | Production + Preview |
| `VITE_PHOENIX_SUPABASE_ANON_KEY` | `eyJ...your-anon-key` | Production + Preview |

**Do NOT add** `PHOENIX_DATABASE_URL` or any `service_role` key to Vercel env vars.

### 3. Deploy
Vercel auto-deploys on every push to `main`. For manual deploy:
```bash
npx vercel --prod
```

### 4. Verify deployment
After deploy:
1. Visit the Vercel URL (e.g. `https://medistock-phoenix.vercel.app`)
2. Confirm login screen renders
3. Log in as `super_admin`
4. Confirm dashboard loads with real data from Supabase

---

## Option B — Static Host (Netlify / GitHub Pages)

### Build
```bash
cd C:\Users\abdal\OneDrive\Desktop\phoenix
npm run build
```

Output is in `dist/`. Deploy the `dist/` directory to any static host.

### Netlify
1. Drag `dist/` to Netlify Drop at [app.netlify.com/drop](https://app.netlify.com/drop)
2. Or connect GitHub repo and set publish directory to `dist`
3. Add env vars in Netlify → Site → Build & deploy → Environment

### SPA routing fix
Add `dist/_redirects` file:
```
/*  /index.html  200
```

---

## Supabase Allowed Origins (CORS)

In [Supabase Dashboard → Authentication → URL Configuration](https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/auth/url-configuration):

Add your staging URL to **Allowed Redirect URLs**:
```
https://medistock-phoenix.vercel.app/**
http://localhost:5174/**
```

---

## Post-Deploy Checklist

- [ ] Login screen renders (RTL Arabic by default)
- [ ] Role chips respond (super_admin selected by default)
- [ ] Dashboard loads real Supabase data
- [ ] QR scan URL works: `{host}/?qid=demo-qr-emergency-01`
- [ ] Dark mode toggle works
- [ ] Language toggle (AR/EN) works
- [ ] Mobile layout correct at 375px
- [ ] No `service_role` in browser network requests
- [ ] No console errors

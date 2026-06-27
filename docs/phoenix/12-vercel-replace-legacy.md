# Phoenix V2 — Replace the Legacy Vercel Deployment

**Goal:** make Phoenix the active production app and stop serving the legacy app.
**Phoenix repo:** `C:\Users\abdal\OneDrive\Desktop\phoenix` (branch `master`, HEAD `75d4628`+)
**Legacy URL today:** `https://medistock-qr-network.vercel.app`
**Supabase project ref:** `eyrzxgfkvqybjdgyphap`

> ⚠️ This step could **not** be automated by the build agent: there is no Vercel CLI
> and no Vercel token in this environment. Do the following from the Vercel
> dashboard (or run the CLI commands locally where you are logged in).

The repo now ships a `vercel.json` with SPA rewrites so deep links like
`/auth/callback` and `/login` resolve to the app (required for the password-reset
link to land correctly).

---

## Build settings (all paths)

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |
| Root Directory | the Phoenix project root |

Environment variables (Production + Preview) — **public Vite vars only**:

```
VITE_PHOENIX_SUPABASE_URL       = https://eyrzxgfkvqybjdgyphap.supabase.co
VITE_PHOENIX_SUPABASE_ANON_KEY  = <anon / publishable key>
```

**Never** add to Vercel: `PHOENIX_DATABASE_URL`, DB password, `service_role`,
secret key, or any non-`VITE_` secret.

---

## Path A — Reuse the existing Vercel project/domain (preferred)

Use this if the project behind `medistock-qr-network.vercel.app` can be repointed.

1. Vercel → the existing project → **Settings → Git**: connect it to the Phoenix
   repo/branch (push Phoenix to GitHub first if it has no remote — see below).
   - If you keep it as a CLI/manual deploy project instead, set Root Directory to
     the Phoenix folder.
2. **Settings → Build & Output**: set Build Command `npm run build`, Output `dist`,
   Framework `Vite`.
3. **Settings → Environment Variables**: set the two `VITE_PHOENIX_*` vars above.
   Remove any leftover legacy/server secrets.
4. **Deployments → Redeploy** (Production). Or, locally: `vercel --prod`.
5. Verify `https://medistock-qr-network.vercel.app` now serves the **Phoenix** UI
   (teal ⚕ "MediStock-Babil" login with email/password — NOT the old role-chip UI).

### Pushing Phoenix to GitHub (if no remote yet)
The Phoenix repo currently has **no git remote**. For Git-based Vercel deploys:
```bash
cd C:\Users\abdal\OneDrive\Desktop\phoenix
gh repo create medistock-phoenix --private --source . --remote origin --push
# or: git remote add origin <url> ; git push -u origin master
```

---

## Path B — New Vercel project + move the domain

Use this if the legacy project can't be safely repointed.

1. Vercel → **New Project** → import the Phoenix repo (or `vercel` from the folder).
2. Set the build settings + env vars above.
3. Deploy → confirm the Phoenix `*.vercel.app` URL works.
4. Move the production **domain** from the legacy project to the Phoenix project:
   legacy project → Settings → Domains → remove the domain; Phoenix project →
   Settings → Domains → add it.
5. Keep the legacy project **disabled/archived** until Phoenix is verified.

---

## Path C — Delete the legacy project (only after verification + approval)

Only delete the legacy Vercel project when ALL are true:
- Phoenix production URL verified working (see `11-final-delivery-report.md` §smoke).
- The domain points to Phoenix.
- Supabase Auth redirect URLs updated (`13-supabase-auth-redirects.md`).
- You explicitly approve deletion (env gate convention: `DELETE_LEGACY_VERCEL_APPROVED=yes`).

If not approved → **archive/disable** the legacy project instead of deleting:
legacy project → Settings → **Pause**/disable production, or remove its domain so
it no longer serves traffic. Disabling is reversible; deletion is not.

---

## Rollback

- **Frontend:** in Vercel, re-promote the previous (legacy) deployment, or re-attach
  the domain to the legacy project. The legacy source remains untouched at
  `C:\Users\abdal\OneDrive\Desktop\ادارة المستشفى\project`.
- **Auth:** revert Supabase Site URL / Redirect URLs to the legacy URL.
- **DB:** no DB change is involved in this step — do **not** re-run any wipe.

---

## Verification checklist (post-deploy)

- [ ] Production URL serves Phoenix login (email/password), not legacy UI
- [ ] `/login` and `/auth/callback` load the SPA (no 404)
- [ ] Network tab shows requests to `eyrzxgfkvqybjdgyphap.supabase.co`
- [ ] No `service_role` / DB URL in any client request
- [ ] Password-reset email link opens the Phoenix domain (see doc 13)

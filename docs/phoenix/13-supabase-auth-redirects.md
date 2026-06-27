# Phoenix V2 — Supabase Auth Redirect Configuration

**Why:** the old password-reset link currently sends users to
`https://medistock-qr-network.vercel.app/login` (legacy). After Phoenix is the
production app, the reset/confirmation emails must land on the Phoenix app's
`/auth/callback` route so the new "set password" screen can run.

**Supabase project:** `eyrzxgfkvqybjdgyphap`
**Where:** Supabase Dashboard → **Authentication → URL Configuration**
(https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/auth/url-configuration)

> ⚠️ Could not be automated: no Supabase admin API / MCP access in this
> environment. Apply these settings manually in the dashboard.

Replace `<FINAL_PHOENIX_PRODUCTION_URL>` with the real production URL once deployed
(e.g. `https://medistock-qr-network.vercel.app` if you reuse that domain, or the new
Phoenix `*.vercel.app` URL).

---

## Site URL

```
<FINAL_PHOENIX_PRODUCTION_URL>
```

## Redirect URLs (allow-list)

```
<FINAL_PHOENIX_PRODUCTION_URL>
<FINAL_PHOENIX_PRODUCTION_URL>/login
<FINAL_PHOENIX_PRODUCTION_URL>/auth/callback
http://localhost:5173
http://localhost:5173/login
http://localhost:5173/auth/callback
http://localhost:5174
http://localhost:5174/login
http://localhost:5174/auth/callback
```

(Local `5173`/`5174` entries let `npm run dev` / `vite preview` exercise the flow.)

---

## How the app uses these

The frontend never hardcodes a URL. The reset request sends:

```ts
// src/shared/supabase/services/auth.service.ts
supabase.auth.resetPasswordForEmail(email, {
  redirectTo: `${window.location.origin}/auth/callback`,
});
```

So the redirect always matches whatever origin the user is on — but Supabase will
**only** honor origins present in the Redirect URLs allow-list above. If an origin
is missing, Supabase falls back to the Site URL.

When the user opens the email link, they land on `<origin>/auth/callback`; the SPA
rewrite (`vercel.json`) serves the app; `detectSessionInUrl` parses the recovery
token; `onAuthStateChange` fires `PASSWORD_RECOVERY`; the app shows the
**Set New Password** screen (`ResetPasswordScreen`), which calls
`supabase.auth.updateUser({ password })`. No `service_role`, no secrets.

---

## Email template (optional, if customized)

If you customized the **Reset Password** email template, ensure the action link uses
the default `{{ .ConfirmationURL }}` (which respects `redirectTo`). Do not hardcode
the legacy URL in the template.

---

## Verify

1. Deploy Phoenix (doc 12) and set the URLs above.
2. On the Phoenix login screen, click **Forgot password?**, enter the user's email.
3. Open the email — the link host must be the Phoenix production URL.
4. Following it should show the Phoenix **Set New Password** screen.
5. Set a new password; confirm you can sign in with it.

If step 3 still points to the legacy URL, the Site URL was not updated or the email
was sent before the change — request a fresh reset email after saving the settings.

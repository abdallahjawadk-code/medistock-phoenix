# Edge Function — `admin-create-user`

Secure server-side user creation for MediStock Phoenix V2. This is the **only**
place the Supabase `service_role` key is used. It must never appear in the
frontend bundle.

## Why an Edge Function

Creating an `auth.users` row requires the Supabase Admin API, which needs the
`service_role` key. Exposing that key in the browser would grant full database
access to anyone. The frontend therefore calls this function with the caller's
JWT; the function verifies the caller's identity and effective permissions
server-side before creating anything.

## Status

**Scaffold — not deployed.** Until it is deployed, the User Management UI keeps
the create-user form disabled with a clear bilingual message. The frontend never
fakes user creation and never creates local-only users.

## Deploy (manual, when ready — not part of this phase)

### Prerequisites

- Migration `010_phoenix_user_permission_matrix.sql` must be applied first. The
  function calls `phoenix_profile_has_permission` and the three permission RPCs
  introduced in that migration.
- `supabase` CLI must be installed and linked to the project.

### Required Supabase secrets

These are **Supabase Function secrets** — set them via the CLI or the Supabase
dashboard under **Project → Settings → Edge Functions → Secrets**. They must
**NOT** be added to Vercel or any frontend env file (`.env`, `VITE_*`).

| Secret | Source | Automatically injected? |
|--------|--------|------------------------|
| `SUPABASE_URL` | Project Settings → API → Project URL | Yes — injected by Supabase |
| `SUPABASE_ANON_KEY` | Project Settings → API → anon key | Yes — injected by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role key | **No — must be set manually** |

> **Security note:** `SUPABASE_SERVICE_ROLE_KEY` grants full database bypass of
> RLS. It must live exclusively in the Deno edge runtime (`Deno.env`). It must
> never appear in the browser bundle, Vercel env vars, or any `VITE_` prefix.
> The function returns `NOT_CONFIGURED` (HTTP 500) if any secret is absent.

### Deployment commands

```bash
# 1. Link to the project (once per machine).
supabase link --project-ref <your-project-ref>

# 2. Set the service role secret (SUPABASE_URL and SUPABASE_ANON_KEY are
#    injected automatically — do not set them manually).
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-dashboard>

# 3. Deploy the function.
supabase functions deploy admin-create-user

# 4. Verify the secret is present (should list SUPABASE_SERVICE_ROLE_KEY).
supabase secrets list
```

### Smoke tests after deployment

Run these manually once the function is live. Use a Supabase JWT from a logged-in
session (copy from browser dev-tools → Application → Local Storage →
`supabase.auth.token`).

```bash
BASE_URL="https://<project-ref>.supabase.co/functions/v1"
TOKEN="<caller-jwt>"

# 1. Unauthenticated request → 401 NOT_AUTHENTICATED
curl -s -X POST "$BASE_URL/admin-create-user" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"T","email":"t@t.com","organization_id":"00000000-0000-0000-0000-000000000000","role":"viewer"}' \
  | jq .
# Expected: {"ok":false,"error":"NOT_AUTHENTICATED"}

# 2. Missing fields → 400 MISSING_FIELDS
curl -s -X POST "$BASE_URL/admin-create-user" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com"}' \
  | jq .
# Expected: {"ok":false,"error":"MISSING_FIELDS"}

# 3. Invalid role → 400 INVALID_ROLE
curl -s -X POST "$BASE_URL/admin-create-user" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"T","email":"t@t.com","organization_id":"<uuid>","role":"hospital_admin"}' \
  | jq .
# Expected: {"ok":false,"error":"INVALID_ROLE"}

# 4. Viewer tries to create a user → 403 INSUFFICIENT_PERMISSION
# (Log in as a viewer account, then run a valid POST with their JWT)
# Expected: {"ok":false,"error":"INSUFFICIENT_PERMISSION"}

# 5. Non-super tries to create super_admin → 403 CANNOT_CREATE_SUPER_ADMIN
# Expected: {"ok":false,"error":"CANNOT_CREATE_SUPER_ADMIN"}

# 6. Happy path (run as super_admin with a real org UUID)
curl -s -X POST "$BASE_URL/admin-create-user" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Smoke Test User","email":"smoketest@example.com","organization_id":"<org-uuid>","role":"viewer"}' \
  | jq .
# Expected: {"ok":true,"user_id":"<uuid>","role":"viewer","invited":true|false}
# After verifying: delete the smoke-test user from auth.users in the dashboard.
```

## Authorization contract

| Caller | Allowed |
|--------|---------|
| `super_admin` | Create any official role in any organization |
| Non-super with `users.create` | Create non-super users **in their own organization only** |
| Anyone else | Rejected (`INSUFFICIENT_PERMISSION`) |

- Only `super_admin` may create `super_admin` (`CANNOT_CREATE_SUPER_ADMIN`).
- No cross-organization creation for non-super (`CROSS_ORG_FORBIDDEN`).
- Official roles only: `super_admin`, `warehouse_officer`, `port_officer`,
  `monthly_status_officer`, `viewer`.

## Request / response

```
POST /functions/v1/admin-create-user
Authorization: Bearer <caller-jwt>
{ "full_name": "...", "email": "...", "organization_id": "uuid", "role": "viewer" }

→ { "ok": true, "user_id": "uuid", "role": "viewer", "invited": true }
→ { "ok": false, "error": "INSUFFICIENT_PERMISSION" }
```

Raw provider errors are never returned — only structured, safe error codes.

## Safety notes

- `service_role` is read from `Deno.env` only; never returned in a response.
- On profile-insert failure the orphaned auth user is deleted to keep state
  consistent.
- The invite email is best-effort and non-fatal.
- This function never deletes users as part of creation.

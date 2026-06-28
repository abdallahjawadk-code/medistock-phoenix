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

```bash
supabase functions deploy admin-create-user
# SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Requires migration `010_phoenix_user_permission_matrix.sql` to be applied first
(the function calls `phoenix_profile_has_permission`).

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
